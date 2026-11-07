import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { EMPTY_INBOX_FILTERS, useInboxFilterStore, type InboxFilters } from "@multica/core/inbox/filter-store";
import { inboxKeys, inboxPagesOptions } from "@multica/core/inbox/queries";
import type { AgentTask, ArchivedInboxPage, InboxItem } from "@multica/core/types";
import { InboxPeek } from "./list-space-peeks";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ inbox: () => "/acme/inbox" }) }));
const push = vi.hoisted(() => vi.fn());
vi.mock("../../navigation", () => ({ useNavigation: () => ({ push }) }));
vi.mock("../../i18n", () => ({ useT: () => ({ t: () => "Inbox" }) }));
vi.mock("../panel-nav", () => ({ PanelHeader: () => null, PanelCount: () => null }));
vi.mock("../../inbox/components/inbox-list", () => ({
  InboxList: ({ items, onSelect, onLoadMore }: {
    items: InboxItem[];
    onSelect: (item: InboxItem) => void;
    onLoadMore?: () => void;
  }) => (
    <div>
      {items.map((row) => <button key={row.id} onClick={() => onSelect(row)}>{row.id}</button>)}
      {onLoadMore && <button onClick={onLoadMore}>Load more</button>}
    </div>
  ),
}));

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-a", workspace_id: "workspace-1", recipient_type: "member",
    recipient_id: "member-1", actor_type: "agent", actor_id: "agent-1",
    type: "new_comment", severity: "info", issue_id: "issue-a",
    title: "Issue title", body: null, issue_status: "todo", issue_priority: "high",
    read: false, archived: false, created_at: "2026-06-15T08:00:00Z", details: null,
    ...overrides,
  };
}

const page = (items: InboxItem[], nextCursor: string | null = null): ArchivedInboxPage =>
  ({ items, hasMore: nextCursor !== null, nextCursor });

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  push.mockClear();
  useInboxFilterStore.setState({ filtersByWorkspace: {} });
});
afterEach(() => { cleanup(); qc.clear(); });

function renderPeek() {
  return render(<QueryClientProvider client={qc}><InboxPeek /></QueryClientProvider>);
}

function setApi(api: Partial<Record<keyof ApiClient, unknown>>) {
  setApiInstance({ getAgentTaskSnapshot: async () => [], getInboxUnreadSummary: async () => [], ...api } as unknown as ApiClient);
}

// The active inbox is paged by the server: its rows sit in the pages under
// `inboxKeys.listPages`, never in a flat list at `inboxKeys.list`.
describe("InboxPeek", () => {
  it("shows the Inbox page's cached active pages without reading them again", async () => {
    const listInboxPage = vi.fn();
    const listInbox = vi.fn();
    setApi({ listInboxPage, listInbox });
    const pagesKey = inboxPagesOptions("workspace-1", EMPTY_INBOX_FILTERS).queryKey;
    expect(pagesKey.slice(0, 4)).toEqual(inboxKeys.listPages("workspace-1"));
    qc.setQueryData(pagesKey, { pages: [page([item(), item({ id: "inbox-b", issue_id: "issue-b" })])], pageParams: [null] });
    // A snapshot the app shell already holds, so the mount's idle refresh runs
    // at once; outside the idle filter it re-reads no page.
    qc.setQueryData(agentTaskSnapshotOptions("workspace-1").queryKey, []);

    renderPeek();

    expect(await screen.findByText("inbox-a")).toBeInTheDocument();
    expect(screen.getByText("inbox-b")).toBeInTheDocument();
    expect(listInboxPage).not.toHaveBeenCalled();
    expect(listInbox).not.toHaveBeenCalled();
  });

  it("asks the server for the saved filters' pages and loads the next page on demand", async () => {
    useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
    const listInboxPage = vi.fn(async (_filters: InboxFilters, { cursor }: { cursor?: string | null }) =>
      cursor ? page([item({ id: "inbox-b", issue_id: "issue-b" })]) : page([item()], "cursor-1"));
    const listInbox = vi.fn();
    setApi({ listInboxPage, listInbox });

    renderPeek();
    // The mount's idle refresh re-reads page 1 once the first snapshot lands.
    await waitFor(() => expect(listInboxPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(qc.isFetching()).toBe(0));

    fireEvent.click(screen.getByText("Load more"));
    expect(await screen.findByText("inbox-b")).toBeInTheDocument();
    expect(screen.getByText("inbox-a")).toBeInTheDocument();
    expect(screen.queryByText("Load more")).toBeNull();
    expect(listInboxPage.mock.calls.map(([filters, { cursor }]) => [filters.idleOnly, cursor])).toEqual([
      [true, null],
      [true, null],
      [true, "cursor-1"],
    ]);
    expect(listInbox).not.toHaveBeenCalled();
  });

  it("lets a running re-read of the shared pages finish when Load more is pressed", async () => {
    let refetch!: { signal?: AbortSignal; resolve: (value: ArchivedInboxPage) => void };
    const listInboxPage = vi.fn()
      .mockResolvedValueOnce(page([item()], "cursor-1"))
      .mockImplementationOnce((_filters: InboxFilters, { signal }: { signal?: AbortSignal }) =>
        new Promise<ArchivedInboxPage>((resolve) => { refetch = { signal, resolve }; }))
      .mockImplementation(async () => page([item({ id: "inbox-b", issue_id: "issue-b" })]));
    setApi({ listInboxPage });

    renderPeek();
    await screen.findByText("Load more");
    // The Inbox page's refresh of the cache the peek shares with it.
    act(() => { void qc.invalidateQueries({ queryKey: inboxKeys.listPages("workspace-1") }); });
    await waitFor(() => expect(listInboxPage).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("Load more"));

    expect(refetch.signal?.aborted).toBe(false);
    expect(listInboxPage).toHaveBeenCalledTimes(2);
    await act(async () => refetch.resolve(page([item(), item({ id: "inbox-c", issue_id: "issue-c" })], "cursor-1")));
    expect(await screen.findByText("inbox-c")).toBeInTheDocument();
  });

  it("opens a row in the Inbox", async () => {
    setApi({ listInboxPage: async () => page([item()]) });

    renderPeek();
    fireEvent.click(await screen.findByText("inbox-a"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/acme/inbox?issue=issue-a"));
  });

  it.each([false, true])("follows the server's idle list when the issue's agent work changes (busy at first: %s)", async (initialBusy) => {
    useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
    let busy = initialBusy;
    const listInboxPage = vi.fn(async (filters: InboxFilters) => page(filters.idleOnly && busy ? [] : [item()]));
    const getAgentTaskSnapshot = async () =>
      busy ? [{ id: "task-a", issue_id: "issue-a", agent_id: "agent-1", status: "running" } as AgentTask] : [];
    setApi({ listInboxPage, getAgentTaskSnapshot });

    renderPeek();
    await waitFor(() => expect(listInboxPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(qc.isFetching()).toBe(0));
    expect(!!screen.queryByText("inbox-a")).toBe(!initialBusy);

    // What the task lifecycle handler does: invalidate the snapshot.
    busy = !busy;
    await act(async () => { await qc.invalidateQueries({ queryKey: agentTaskSnapshotOptions("workspace-1").queryKey }); });

    await waitFor(() => expect(!!screen.queryByText("inbox-a")).toBe(initialBusy));
  });
});
