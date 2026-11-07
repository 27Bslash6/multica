package handler

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The handlers copy params field by field between the active and archived
// generated types, which differ by the idle dimension. A dimension added to
// one view's query and not the other would otherwise be dropped silently.
func TestInboxParamsDifferOnlyByIdle(t *testing.T) {
	fields := func(v any) []string {
		var names []string
		for field := range reflect.TypeOf(v).Fields() {
			if field.Name != "IdleOnly" {
				names = append(names, field.Name)
			}
		}
		return names
	}
	for _, pair := range [][2]any{
		{db.ListInboxPageParams{}, db.ListArchivedInboxPageParams{}},
		{db.InboxFacetsParams{}, db.ArchivedInboxFacetsParams{}},
	} {
		if active, archived := fields(pair[0]), fields(pair[1]); !slices.Equal(active, archived) {
			t.Fatalf("%T fields %v, %T fields %v", pair[0], active, pair[1], archived)
		}
	}
}

func TestInboxPagePagesActiveGroups(t *testing.T) {
	ws := dbfx.Workspace(t, "Paged inbox", "inbox-page-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	for range 205 {
		dbfx.Issue(t, "Active", testutil.Cols{"workspace_id": ws})
	}
	// Each group holds an older and a newer active row plus an even newer
	// archived one, which must never represent the group. Every newest active
	// row shares one timestamp, so the ID tie-breaker decides every page boundary.
	created := time.Now().UTC().Truncate(time.Microsecond)
	dbfx.Exec(t, `
		INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, type, severity, issue_id, title, archived, created_at)
		SELECT $1, 'member', $2, 'mentioned', 'info', iss.id, row.title, row.archived, $3::timestamptz + row.offset_ms * interval '1 millisecond'
		FROM issue iss
		CROSS JOIN (VALUES ('older', false, -60000), ('newest active', false, 0), ('archived', true, 60000)) AS row(title, archived, offset_ms)
		WHERE iss.workspace_id = $1
	`, ws, testUserID, created)
	// Two archived-only notifications give the archive a second page.
	dbfx.Exec(t, `
		INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, type, severity, title, archived)
		SELECT $1, 'member', $2, 'mentioned', 'info', 'archived only', true FROM generate_series(1, 2)
	`, ws, testUserID)
	dbfx.Cleanup(t, `DELETE FROM inbox_item WHERE workspace_id = $1`, ws)

	seen := map[string]bool{}
	cursor := ""
	var firstCursor string
	for pageNumber := 0; ; pageNumber++ {
		if pageNumber > 5 {
			t.Fatal("pagination did not terminate")
		}
		var page inboxPageResponse
		path := "/api/inbox/page?limit=50&cursor=" + url.QueryEscape(cursor)
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), inboxRequest(http.MethodGet, path, ws)).Want(http.StatusOK).JSON(&page)
		for _, item := range page.Items {
			if item.IssueID == nil || seen[*item.IssueID] {
				t.Fatalf("missing or duplicate group: %+v", item)
			}
			if item.Archived || item.Title != "newest active" {
				t.Fatalf("group not represented by its newest active row: %+v", item)
			}
			seen[*item.IssueID] = true
		}
		if !page.HasMore {
			if page.NextCursor != nil {
				t.Fatal("last page has a cursor")
			}
			break
		}
		if len(page.Items) != 50 || page.NextCursor == nil {
			t.Fatalf("invalid page: %+v", page)
		}
		cursor = *page.NextCursor
		if firstCursor == "" {
			firstCursor = cursor
		}
	}
	if len(seen) != 205 {
		t.Fatalf("got %d groups, want 205", len(seen))
	}

	// Installed clients keep the unbounded, ungrouped array.
	var legacy []InboxItemResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInbox), inboxRequest(http.MethodGet, "/api/inbox", ws)).Want(http.StatusOK).JSON(&legacy)
	if len(legacy) != 410 {
		t.Fatalf("legacy inbox = %d rows, want every active row (410)", len(legacy))
	}

	var archived archivedInboxPageResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?limit=1", ws)).Want(http.StatusOK).JSON(&archived)
	if !archived.HasMore || archived.NextCursor == nil || archived.Items[0].Title != "archived only" {
		t.Fatalf("archive must hold only the archived-only groups: %+v", archived)
	}
	for _, query := range []string{"limit=0", "limit=101", "cursor=broken", "group_id=bad", "unread_only=bad", "statuses=a,,b",
		"unread_only=true&cursor=" + firstCursor, "limit=1&cursor=" + *archived.NextCursor} {
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), inboxRequest(http.MethodGet, "/api/inbox/page?"+query, ws)).Want(http.StatusBadRequest)
	}
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?cursor="+firstCursor, ws)).Want(http.StatusBadRequest)
}

func TestInboxPageFiltersLookupAndCommentAnchor(t *testing.T) {
	ws := dbfx.Workspace(t, "Inbox filters", "inbox-filter-page-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	issue := dbfx.Issue(t, "Older matching group", testutil.Cols{"workspace_id": ws, "status": "in_review", "priority": "high"})
	actor := uuid.NewString()
	comment := uuid.NewString()
	old := time.Now().UTC().Add(-time.Hour)
	insert := func(issueID *string, read bool, actorType string, actorID *string, created time.Time, details string, archived bool) string {
		return dbfx.Insert(t, "inbox_item", testutil.Cols{
			"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"type": "mentioned", "severity": "info", "title": "Inbox filter", "issue_id": issueID,
			"read": read, "actor_type": actorType, "actor_id": actorID, "archived": archived,
			"created_at": created, "details": details,
		})
	}
	insert(&issue, false, "agent", &actor, old.Add(-time.Minute), `{"comment_id":"`+comment+`"}`, false)
	newest := insert(&issue, true, "system", nil, old, `{}`, false)
	// A newer archived anchor belongs to the archive, not to the active group.
	insert(&issue, false, "agent", &actor, old.Add(30*time.Second), `{"comment_id":"`+uuid.NewString()+`"}`, true)
	// Fill the newest page with nonmatching groups, so a local filter would miss the match.
	for range 55 {
		insert(nil, false, "agent", &actor, old.Add(time.Minute), `{}`, false)
	}
	get := func(query string) inboxPageResponse {
		var page inboxPageResponse
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), inboxRequest(http.MethodGet, "/api/inbox/page?"+query, ws)).Want(http.StatusOK).JSON(&page)
		return page
	}
	getArchived := func(query string) archivedInboxPageResponse {
		var page archivedInboxPageResponse
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?"+query, ws)).Want(http.StatusOK).JSON(&page)
		return page
	}
	page := get("statuses=in_review&priorities=high&actors=system")
	if len(page.Items) != 1 || page.Items[0].ID != newest {
		t.Fatalf("filter lost older match: %+v", page)
	}
	if string(page.Items[0].Details) != `{"comment_id":"`+comment+`"}` {
		t.Fatalf("comment anchor not taken from the newest active row carrying one: %s", page.Items[0].Details)
	}
	if page.Items[0].IssueStatus == nil || *page.Items[0].IssueStatus != "in_review" || page.Items[0].IssuePriority == nil || *page.Items[0].IssuePriority != "high" {
		t.Fatalf("issue projection missing: %+v", page.Items[0])
	}
	if len(get("group_id="+issue+"&unread_only=true").Items) != 0 {
		t.Fatal("older unread notification matched")
	}
	if len(get("group_id="+issue+"&actors=agent:"+actor).Items) != 0 {
		t.Fatal("older actor matched")
	}
	if len(get("group_id="+issue).Items) != 1 {
		t.Fatal("deep link outside first page did not resolve")
	}
	if len(getArchived("group_id="+issue).Items) != 0 {
		t.Fatal("issue with an active row also appeared in the archive")
	}

	var facets inboxFacetsResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.GetInboxFacets), inboxRequest(http.MethodGet, "/api/inbox/facets?actors=system", ws)).Want(http.StatusOK).JSON(&facets)
	if facets.Statuses["in_review"] != 1 || facets.Priorities["high"] != 1 || facets.Actors["agent:"+actor] != 55 || facets.Actors["system"] != 1 || facets.UnreadCount != 0 {
		t.Fatalf("incorrect facets: %+v", facets)
	}
	testutil.Call(t, inboxWorkspaceHandler(testHandler.GetInboxFacets), inboxRequest(http.MethodGet, "/api/inbox/facets", ws)).Want(http.StatusOK).JSON(&facets)
	if facets.UnreadCount != 55 {
		t.Fatalf("unread facet counts rendered rows, want 55 unread groups: %+v", facets)
	}

	// Archiving the group moves it from one view to the other.
	dbfx.Exec(t, `UPDATE inbox_item SET archived = true WHERE issue_id = $1`, issue)
	if len(get("group_id="+issue).Items) != 0 || len(getArchived("group_id="+issue).Items) != 1 {
		t.Fatal("archived group still listed as active")
	}
	dbfx.Exec(t, `UPDATE inbox_item SET archived = false WHERE issue_id = $1`, issue)

	// Another recipient and another workspace cannot read this inbox, including lookup.
	otherWS := dbfx.Workspace(t, "Other inbox", "other-inbox-"+uuid.NewString())
	dbfx.Member(t, otherWS, testUserID, "owner")
	var other inboxPageResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), inboxRequest(http.MethodGet, "/api/inbox/page?group_id="+issue, otherWS)).Want(http.StatusOK).JSON(&other)
	if len(other.Items) != 0 {
		t.Fatal("cross-workspace inbox leak")
	}
	otherUser := dbfx.User(t, "Other recipient", uuid.NewString()+"@example.test")
	dbfx.Member(t, ws, otherUser, "member")
	req := inboxRequest(http.MethodGet, "/api/inbox/page?group_id="+issue, ws)
	req.Header.Set("X-User-ID", otherUser)
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), req).Want(http.StatusOK).JSON(&other)
	if len(other.Items) != 0 {
		t.Fatal("cross-recipient inbox leak")
	}
	for _, handler := range []http.HandlerFunc{testHandler.ListInboxPage, testHandler.GetInboxFacets} {
		req := inboxRequest(http.MethodGet, "/api/inbox/page", ws)
		req.Header.Set("X-User-ID", uuid.NewString())
		testutil.Call(t, inboxWorkspaceHandler(handler), req).Want(http.StatusNotFound)
	}
}

// Archived cursors issued before the active view existed must keep verifying,
// so the archived scope is pinned to the bytes it has always hashed. Active
// cursors issued before the idle dimension existed keep verifying too.
func TestInboxPageScopeKeepsArchivedCursorsValid(t *testing.T) {
	filters := inboxFilters{
		WorkspaceID: parseUUID(uuid.NewString()), RecipientID: parseUUID(uuid.NewString()),
		Statuses: []string{"todo"}, Priorities: []string{}, Actors: []string{"system"}, UnreadOnly: true,
	}
	for _, group := range []pgtype.UUID{{}, parseUUID(uuid.NewString())} {
		archived := inboxPageScope(archivedInboxView, filters, false, group)
		if want := oldArchivedInboxScope(t, filters, group); archived != want {
			t.Fatalf("archived scope changed: got %s, want %s", archived, want)
		}
		active := inboxPageScope(activeInboxView, filters, false, group)
		encoded, err := json.Marshal(struct {
			View    inboxView
			Filters inboxFilters
			Group   pgtype.UUID
		}{activeInboxView, filters, group})
		if err != nil {
			t.Fatal(err)
		}
		if want := fmt.Sprintf("%x", sha256.Sum256(encoded)); active != want {
			t.Fatalf("active scope without the idle dimension changed: got %s, want %s", active, want)
		}
		if active == archived {
			t.Fatal("active and archived cursors share a scope")
		}
		if inboxPageScope(activeInboxView, filters, true, group) == active {
			t.Fatal("idle and unfiltered active cursors share a scope")
		}
	}
}

// oldArchivedInboxScope hashes an archived scope the way it was hashed before
// the active view and its idle dimension existed.
func oldArchivedInboxScope(t *testing.T, filters inboxFilters, group pgtype.UUID) string {
	t.Helper()
	encoded, err := json.Marshal(struct {
		Filters inboxFilters
		Group   pgtype.UUID
	}{filters, group})
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func TestInboxPageIdleDimension(t *testing.T) {
	ws := dbfx.Workspace(t, "Idle inbox", "inbox-idle-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	runtime := dbfx.Runtime(t, "Idle inbox runtime", testutil.Cols{"workspace_id": ws})
	agent := dbfx.Agent(t, "Idle inbox agent", runtime, testutil.Cols{"workspace_id": ws})
	issue := func(title string, tasks ...testutil.Cols) string {
		id := dbfx.Issue(t, title, testutil.Cols{"workspace_id": ws})
		for _, task := range tasks {
			task["issue_id"], task["runtime_id"] = id, runtime
			dbfx.Task(t, agent, task)
		}
		return id
	}
	wakeup := testutil.Raw(`jsonb_build_object('wakeup_id', gen_random_uuid()::text)`)
	noTask := issue("No task")
	// Finished work and a deferred retry no wakeup holds are not activity.
	finished := issue("Finished", testutil.Cols{"status": "completed"}, testutil.Cols{"status": "failed"},
		testutil.Cols{"status": "cancelled"}, testutil.Cols{"status": "deferred"})
	idle := map[string]bool{noTask: true, finished: true}
	running := issue("Running", testutil.Cols{"status": "running"}, testutil.Cols{"status": "completed"})
	queued := issue("Queued", testutil.Cols{"status": "queued"})
	dispatched := issue("Dispatched", testutil.Cols{"status": "dispatched"})
	waiting := issue("Waiting for a directory", testutil.Cols{"status": "waiting_local_directory"})
	deferred := issue("Deferred wakeup", testutil.Cols{"status": "deferred", "context": wakeup})
	// Interleave idle, busy and issue-less groups in time, oldest first, so the
	// idle walk crosses pages the unfiltered list fills with other groups.
	created := time.Now().UTC().Truncate(time.Microsecond)
	groups := []*string{&noTask, &running, nil, &queued, &finished, &dispatched, nil, &waiting, &deferred}
	busy := []string{running, queued, dispatched, waiting, deferred}
	for i, group := range groups {
		dbfx.Insert(t, "inbox_item", testutil.Cols{
			"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"type": "mentioned", "severity": "info", "title": "Idle", "issue_id": group,
			"read": i%2 == 0, "created_at": created.Add(time.Duration(i) * time.Second),
		})
	}
	walk := func(query string) []string {
		t.Helper()
		var groups []string
		cursor := ""
		for pages := 0; ; pages++ {
			if pages > len(idle)+len(busy)+2 {
				t.Fatal("pagination did not terminate")
			}
			var page inboxPageResponse
			path := "/api/inbox/page?limit=1&" + query + "&cursor=" + url.QueryEscape(cursor)
			testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), inboxRequest(http.MethodGet, path, ws)).Want(http.StatusOK).JSON(&page)
			for _, item := range page.Items {
				if item.IssueID == nil {
					groups = append(groups, "")
					continue
				}
				groups = append(groups, *item.IssueID)
			}
			if !page.HasMore {
				return groups
			}
			cursor = *page.NextCursor
		}
	}
	facets := func(query string) inboxFacetsResponse {
		t.Helper()
		var facets inboxFacetsResponse
		testutil.Call(t, inboxWorkspaceHandler(testHandler.GetInboxFacets), inboxRequest(http.MethodGet, "/api/inbox/facets?"+query, ws)).Want(http.StatusOK).JSON(&facets)
		if facets.IdleCount == nil {
			t.Fatalf("active facets without an idle count: %+v", facets)
		}
		return facets
	}

	got := walk("idle_only=true")
	if len(got) != len(idle) {
		t.Fatalf("idle walk = %v, want the %d idle issues", got, len(idle))
	}
	for _, id := range got {
		if !idle[id] {
			t.Fatalf("idle walk listed a busy or issue-less group %q: %v", id, got)
		}
	}
	if all := walk("idle_only=false"); len(all) != len(groups) {
		t.Fatalf("unfiltered walk = %d groups, want %d", len(all), len(groups))
	}
	// The busy rule is a copy of the task snapshot's, which the activity badge
	// reads; an upstream change to either would not conflict on merge. Every
	// snapshot row but each agent's latest completed or failed task is active.
	snapshot, err := testHandler.Queries.ListWorkspaceAgentTaskSnapshot(t.Context(), parseUUID(ws))
	if err != nil {
		t.Fatal(err)
	}
	snapshotBusy := map[string]bool{}
	for _, task := range snapshot {
		if task.Status != "completed" && task.Status != "failed" {
			snapshotBusy[uuidToString(task.IssueID)] = true
		}
	}
	for _, id := range append([]string{noTask, finished}, busy...) {
		if idle[id] == snapshotBusy[id] {
			t.Fatalf("issue %s: idle = %v, but the task snapshot counts it busy = %v", id, idle[id], snapshotBusy[id])
		}
	}
	// The idle count is faceted like the unread count: it respects the other
	// dimensions, never its own, and equals the idle walk under the same filters.
	for _, query := range []string{"", "unread_only=true", "statuses=todo", "statuses=done", "actors=system"} {
		if count, rows := *facets(query).IdleCount, len(walk("idle_only=true&"+query)); count != int64(rows) {
			t.Fatalf("idle facet under %q = %d, idle walk = %d", query, count, rows)
		}
		if count := *facets(query + "&idle_only=true").IdleCount; count != *facets(query).IdleCount {
			t.Fatalf("idle facet under %q counts its own dimension: %d", query, count)
		}
	}
	idleFacets := facets("idle_only=true")
	if idleFacets.Statuses["todo"] != int64(len(idle)) || idleFacets.UnreadCount != int64(len(walk("idle_only=true&unread_only=true"))) {
		t.Fatalf("other dimensions ignore the idle selection: %+v", idleFacets)
	}

	// An issue whose agent finishes becomes idle.
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed' WHERE issue_id = $1 AND status = 'running'`, running)
	if got := walk("idle_only=true"); len(got) != len(idle)+1 || *facets("").IdleCount != int64(len(idle)+1) {
		t.Fatalf("finished issue did not become idle: %v", got)
	}

	// A cursor is scoped to the idle selection.
	var first inboxPageResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), inboxRequest(http.MethodGet, "/api/inbox/page?limit=1&idle_only=true", ws)).Want(http.StatusOK).JSON(&first)
	for _, query := range []string{"idle_only=bad", "limit=1&cursor=" + *first.NextCursor} {
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInboxPage), inboxRequest(http.MethodGet, "/api/inbox/page?"+query, ws)).Want(http.StatusBadRequest)
	}
	testutil.Call(t, inboxWorkspaceHandler(testHandler.GetInboxFacets), inboxRequest(http.MethodGet, "/api/inbox/facets?idle_only=bad", ws)).Want(http.StatusBadRequest)
}

// The archive has no idle dimension: it ignores the parameter and answers
// without an idle count. TestInboxPageScopeKeepsArchivedCursorsValid pins its
// cursor scope.
func TestArchivedInboxIgnoresIdleDimension(t *testing.T) {
	ws := dbfx.Workspace(t, "Idle archive", "inbox-idle-archive-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	runtime := dbfx.Runtime(t, "Idle archive runtime", testutil.Cols{"workspace_id": ws})
	agent := dbfx.Agent(t, "Idle archive agent", runtime, testutil.Cols{"workspace_id": ws})
	busy := dbfx.Issue(t, "Busy archived", testutil.Cols{"workspace_id": ws})
	dbfx.Task(t, agent, testutil.Cols{"issue_id": busy, "runtime_id": runtime, "status": "running"})
	created := time.Now().UTC().Truncate(time.Microsecond)
	for i, group := range []*string{&busy, nil, nil} {
		dbfx.Insert(t, "inbox_item", testutil.Cols{
			"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"type": "mentioned", "severity": "info", "title": "Archived", "issue_id": group,
			"archived": true, "created_at": created.Add(time.Duration(i) * time.Second),
		})
	}
	get := func(query string, status int) archivedInboxPageResponse {
		t.Helper()
		var page archivedInboxPageResponse
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?"+query, ws)).Want(status).JSON(&page)
		return page
	}
	for _, query := range []string{"", "idle_only=true", "idle_only=bad"} {
		if page := get(query, http.StatusOK); len(page.Items) != 3 {
			t.Fatalf("archive applied an idle dimension under %q: %+v", query, page)
		}
	}

	var facets map[string]json.RawMessage
	testutil.Call(t, inboxWorkspaceHandler(testHandler.GetArchivedInboxFacets), inboxRequest(http.MethodGet, "/api/inbox/archived/facets?idle_only=true", ws)).Want(http.StatusOK).JSON(&facets)
	if _, ok := facets["idle_count"]; ok || string(facets["unread_count"]) != "3" {
		t.Fatalf("archived facets changed shape: %v", facets)
	}
}
