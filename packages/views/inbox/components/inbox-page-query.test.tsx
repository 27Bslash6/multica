import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { EMPTY_INBOX_FILTERS, useInboxFilterStore, type InboxFilters } from "@multica/core/inbox/filter-store";
import { archivedInboxLookupOptions, inboxKeys, inboxLookupOptions, inboxPagesOptions } from "@multica/core/inbox/queries";
import { onInboxInvalidate, onInboxIssueDeleted, patchInboxIssueProjection } from "@multica/core/inbox/ws-updaters";
import type { ArchivedInboxPage as InboxPageData } from "@multica/core/types/inbox";
import type { AgentTask, InboxItem } from "@multica/core/types";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { InboxPage } from "./inbox-page";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    inbox: () => "/acme/inbox",
    issueDetail: (id: string) => `/acme/issues/${id}`,
  }),
}));
vi.mock("../../modals/use-issue-limit-upgrade-prompt", () => ({
  useIssueLimitUpgradePrompt: () => vi.fn(),
}));

const detailUnmounted = vi.hoisted(() => vi.fn());
vi.mock("../../issues/components/issue-detail", () => ({
  IssueDetail: ({ issueId }: { issueId: string }) => {
    useEffect(() => () => detailUnmounted(issueId), [issueId]);
    return <div data-testid="detail">{issueId}</div>;
  },
  issueHighlightMementoKey: (issueId: string) => `highlight:${issueId}`,
}));
const replace = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ searchParams, replace }),
  useReportNavigating: () => {},
}));
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsCompact: () => false }));
vi.mock("@multica/ui/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock("./inbox-list", () => ({
  InboxList: ({ items, onSelect }: { items: InboxItem[]; onSelect: (item: InboxItem) => void }) => (
    <div>{items.map((row) => (
      <button key={row.id} data-read={row.read} onClick={() => onSelect(row)}>{row.id}</button>
    ))}</div>
  ),
}));
vi.mock("./inbox-filter-menu", () => ({ InboxFilterMenu: () => null }));
vi.mock("./inbox-list-item", () => ({ useTimeAgo: () => vi.fn() }));
let rowActions: { onAction: (id: string) => void; onMarkRead: (id: string) => void };
vi.mock("./inbox-context-menu", () => ({
  InboxContextMenuProvider: ({ actions, children }: { actions: typeof rowActions; children: ReactNode }) => {
    rowActions = actions;
    return children;
  },
}));
vi.mock("./inbox-detail-label", () => ({ useTypeLabels: () => ({}) }));
vi.mock("../../i18n", () => {
  const t = () => "Inbox";
  return { useT: () => ({ t }) };
});

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

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity, gcTime: 0 },
    mutations: { retry: false },
  } });
  searchParams = new URLSearchParams();
  replace.mockClear();
  detailUnmounted.mockClear();
  useInboxFilterStore.setState({ filtersByWorkspace: {} });
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
});
afterEach(() => { cleanup(); qc.clear(); });

function renderPage() {
  return render(<QueryClientProvider client={qc}><InboxPage /></QueryClientProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const page = (items: InboxItem[]): InboxPageData => ({ items, hasMore: false, nextCursor: null });

function archivedFixture() {
  searchParams = new URLSearchParams("view=archived");
  const readGate = deferred<void>();
  const lookup = deferred<InboxPageData>();
  const a = item({ archived: true });
  let rows = [a, item({ id: "inbox-b", issue_id: "issue-b", archived: true })];
  const listArchivedInboxPage = vi.fn(async (filters: InboxFilters, options: { groupId?: string }) => {
    if (options.groupId === "issue-a") return lookup.promise;
    if (options.groupId) return page(rows.filter((row) => row.issue_id === options.groupId));
    return page(rows.filter((row) => !filters.unreadOnly || !row.read));
  });
  const markInboxRead = vi.fn(async (id: string) => {
    if (id === a.id) await readGate.promise;
    rows = rows.map((row) => row.id === id ? { ...row, read: true } : row);
    return rows.find((row) => row.id === id)!;
  });
  const unarchiveInbox = vi.fn(async () => {
    rows = rows.filter((row) => row.id !== a.id);
    return { ...a, read: true, archived: false };
  });
  setApiInstance({ listArchivedInboxPage, markInboxRead, unarchiveInbox,
    getInboxUnreadSummary: async () => [],
  } as unknown as ApiClient);
  return { a, readGate, lookup, listArchivedInboxPage, unarchiveInbox,
    remove: () => { rows = rows.filter((row) => row.id !== a.id); },
  };
}

async function openArchived(fixture: ReturnType<typeof archivedFixture>, viaUrl = false) {
  if (viaUrl) searchParams.set("issue", "issue-a");
  renderPage();
  const row = await screen.findByText("inbox-a");
  if (!viaUrl) fireEvent.click(row);
  const detail = await screen.findByTestId("detail");
  await waitFor(() => expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "true"));
  await act(async () => fixture.readGate.resolve());
  await waitFor(() => expect(fixture.listArchivedInboxPage.mock.calls.some((call) => call[1].groupId === "issue-a")).toBe(true));
  return detail;
}

it("keeps the active read selection until moving to another notification", async () => {
  // The active view is paged and filtered by the server, so the unread page
  // re-read drops the row just read; the row stays listed from its lookup.
  let rows = [item(), item({ id: "inbox-b", issue_id: "issue-b" })];
  const listInboxPage = vi.fn(async (filters: InboxFilters, options: { groupId?: string }) => {
    if (options.groupId) return page(rows.filter((row) => row.issue_id === options.groupId));
    return page(rows.filter((row) => !filters.unreadOnly || !row.read));
  });
  const pageReads = () => listInboxPage.mock.calls.filter((call) => !call[1].groupId).length;
  const markInboxRead = vi.fn(async (id: string) => {
    rows = rows.map((row) => row.id === id ? { ...row, read: true } : row);
    return rows.find((row) => row.id === id)!;
  });
  setApiInstance({ listInboxPage, markInboxRead, getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await waitFor(() => expect(pageReads()).toBe(2));
  expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "true");
  expect(screen.getByTestId("detail")).toHaveTextContent("issue-a");
  fireEvent.click(screen.getByText("inbox-b"));
  await waitFor(() => expect(pageReads()).toBe(3));
  expect(screen.getByTestId("detail")).toHaveTextContent("issue-b");
  expect(screen.queryByText("inbox-a")).not.toBeInTheDocument();
  expect(screen.getByText("inbox-b")).toHaveAttribute("data-read", "true");
});

// Every write fails, but only when the test releases it: an unguarded retry
// then shows up as one more pending call instead of thousands of renders.
function failingReadFixture(rows: InboxItem[]) {
  vi.mocked(toast.error).mockClear();
  const listInboxPage = vi.fn(async (filters: InboxFilters, options: { groupId?: string }) => {
    if (options.groupId) return page(rows.filter((row) => row.issue_id === options.groupId));
    return page(rows.filter((row) => !filters.unreadOnly || !row.read));
  });
  const pending: ((err: Error) => void)[] = [];
  const markInboxRead = vi.fn((_id: string) => new Promise<InboxItem>((_resolve, reject) => { pending.push(reject); }));
  setApiInstance({ listInboxPage, markInboxRead, getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  return {
    pageReads: () => listInboxPage.mock.calls.filter((call) => !call[1].groupId).length,
    markReads: (id: string) => markInboxRead.mock.calls.filter(([called]) => called === id).length,
    failWrites: () => act(async () => {
      for (const reject of pending.splice(0)) reject(new Error("server error"));
    }),
    quiet: () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 100); })),
  };
}

it.each([true, false])("tries a failing mark-read once while the row stays open, not again on every rollback (unread only: %s)", async (unreadOnly) => {
  // The failure rolls the open row back to unread, which is what auto-read
  // reacts to: unguarded, each failure starts another write, another inbox
  // re-read and another toast.
  if (!unreadOnly) useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  const { pageReads, markReads, failWrites, quiet } = failingReadFixture([item()]);

  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await waitFor(() => expect(markReads("inbox-a")).toBe(1));
  await failWrites();
  await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
  await waitFor(() => expect(pageReads()).toBeGreaterThanOrEqual(2));
  const readsAfterFailure = pageReads();
  await quiet();
  expect(markReads("inbox-a")).toBe(1);
  expect(pageReads()).toBe(readsAfterFailure);
  expect(toast.error).toHaveBeenCalledOnce();
  expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "false");
});

it("tries a failed mark-read once more when the row is opened again", async () => {
  // Opening a row that is already read writes nothing, so only leaving the
  // failed row can release it for the next open.
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  const { markReads, failWrites, quiet } = failingReadFixture([
    item(), item({ id: "inbox-b", issue_id: "issue-b", read: true }),
  ]);

  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await waitFor(() => expect(markReads("inbox-a")).toBe(1));
  await failWrites();
  await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText("inbox-b"));
  await waitFor(() => expect(screen.getByTestId("detail")).toHaveTextContent("issue-b"));
  fireEvent.click(screen.getByText("inbox-a"));
  await waitFor(() => expect(markReads("inbox-a")).toBe(2));
  await failWrites();
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
  await quiet();
  expect(markReads("inbox-a")).toBe(2);
  expect(markReads("inbox-b")).toBe(0);
});

it("marks the open row read again when it turns unread after a write that succeeded", async () => {
  // Only a failed write holds the row back: another client flagging it
  // unread while it is open still gets it read again.
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  let rows = [item()];
  const listInboxPage = vi.fn(async (_filters: InboxFilters, options: { groupId?: string }) =>
    page(rows.filter((row) => !options.groupId || row.issue_id === options.groupId)));
  const markInboxRead = vi.fn(async (id: string) => {
    rows = rows.map((row) => row.id === id ? { ...row, read: true } : row);
    return rows.find((row) => row.id === id)!;
  });
  setApiInstance({ listInboxPage, markInboxRead, getInboxUnreadSummary: async () => [] } as unknown as ApiClient);

  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await waitFor(() => expect(markInboxRead).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "true"));
  rows = rows.map((row) => ({ ...row, read: false }));
  await act(async () => { await onInboxInvalidate(qc, "workspace-1"); });
  await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
});

it("marks the open row read again when it turns unread after an explicit read succeeded", async () => {
  // The auto-read failed, so the row is held back; reading it explicitly
  // proves the server accepts the write and releases it.
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  let rows = [item()];
  const markInboxRead = vi.fn(async (id: string) => {
    if (markInboxRead.mock.calls.length === 1) throw new Error("server error");
    rows = rows.map((row) => row.id === id ? { ...row, read: true } : row);
    return rows.find((row) => row.id === id)!;
  });
  setApiInstance({ listInboxPage: async () => page(rows), markInboxRead,
    getInboxUnreadSummary: async () => [],
  } as unknown as ApiClient);
  const quiet = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 100); }));

  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await waitFor(() => expect(markInboxRead).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "false"));
  await quiet();
  act(() => rowActions.onMarkRead("inbox-a"));
  await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "true"));
  await quiet();
  rows = rows.map((row) => ({ ...row, read: false }));
  await act(async () => { await onInboxInvalidate(qc, "workspace-1"); });
  await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(3));
});

it("marks the open row read again after its auto-read succeeded behind an explicit read of another row", async () => {
  // Both writes share one mutation hook, so the explicit read replaces the
  // auto-read's mutate() callbacks while the auto-read is still in flight.
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  let rows = [item(), item({ id: "inbox-b", issue_id: "issue-b" })];
  const gate = deferred<void>();
  const markInboxRead = vi.fn(async (id: string) => {
    rows = rows.map((row) => row.id === id ? { ...row, read: true } : row);
    if (id === "inbox-a" && markInboxRead.mock.calls.filter(([called]) => called === id).length === 1) await gate.promise;
    return rows.find((row) => row.id === id)!;
  });
  setApiInstance({ listInboxPage: async () => page(rows), markInboxRead,
    getInboxUnreadSummary: async () => [],
  } as unknown as ApiClient);
  const quiet = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 100); }));

  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await waitFor(() => expect(markInboxRead).toHaveBeenCalledOnce());
  act(() => rowActions.onMarkRead("inbox-b"));
  await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
  await act(async () => gate.resolve());
  await quiet();
  expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "true");
  rows = rows.map((row) => row.id === "inbox-a" ? { ...row, read: false } : row);
  await act(async () => { await onInboxInvalidate(qc, "workspace-1"); });
  await waitFor(() => expect(markInboxRead.mock.calls.filter(([id]) => id === "inbox-a")).toHaveLength(2));
});

it.each(["click", "url"])("keeps the archived row and detail mounted through refetch and slow lookup after %s selection, then releases the pin", async (selection) => {
  const fixture = archivedFixture();
  const detail = await openArchived(fixture, selection === "url");
  expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "true");
  expect(screen.getByTestId("detail")).toBe(detail);
  expect(detailUnmounted).not.toHaveBeenCalled();
  await act(async () => fixture.lookup.resolve(page([{ ...fixture.a, read: true }])));
  expect(screen.getByText("inbox-a")).toHaveAttribute("data-read", "true");
  expect(screen.getByTestId("detail")).toBe(detail);
  expect(detailUnmounted).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalledWith("/acme/inbox?view=archived");
  fireEvent.click(screen.getByText("inbox-b"));
  await waitFor(() => expect(screen.getByTestId("detail")).toHaveTextContent("issue-b"));
  expect(screen.queryByText("inbox-a")).not.toBeInTheDocument();
});

it("keeps reading through lookup failure and clears a confirmed missing notification", async () => {
  const fixture = archivedFixture();
  const detail = await openArchived(fixture);
  await act(async () => fixture.lookup.reject(new Error("offline")));
  await waitFor(() => expect(qc.getQueryState(archivedInboxLookupOptions("workspace-1", "issue-a").queryKey)?.status).toBe("error"));
  expect(screen.getByText("inbox-a")).toBeInTheDocument();
  expect(screen.getByTestId("detail")).toBe(detail);
  expect(detailUnmounted).not.toHaveBeenCalled();
  fixture.listArchivedInboxPage.mockImplementation(async () => page([]));
  await act(async () => { await qc.invalidateQueries({ queryKey: inboxKeys.archived("workspace-1") }); });
  await waitFor(() => expect(screen.queryByTestId("detail")).not.toBeInTheDocument());
  expect(screen.queryByText("inbox-a")).not.toBeInTheDocument();
  expect(replace).toHaveBeenLastCalledWith("/acme/inbox?view=archived");
});

it("removes a pinned archived notification when its issue is deleted", async () => {
  const fixture = archivedFixture();
  await openArchived(fixture);
  fixture.remove();
  fixture.listArchivedInboxPage.mockImplementation(async () => page([]));
  await act(async () => { await onInboxIssueDeleted(qc, "workspace-1", "issue-a"); });
  await waitFor(() => expect(screen.queryByTestId("detail")).not.toBeInTheDocument());
  expect(screen.queryByText("inbox-a")).not.toBeInTheDocument();
  expect(replace).toHaveBeenLastCalledWith("/acme/inbox?view=archived");
});

it("restores a pinned notification without keeping it in the archived list", async () => {
  const fixture = archivedFixture();
  await openArchived(fixture);
  await act(async () => fixture.lookup.resolve(page([{ ...fixture.a, read: true }])));
  act(() => rowActions.onAction("inbox-a"));
  await waitFor(() => expect(fixture.unarchiveInbox).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByTestId("detail")).toHaveTextContent("issue-b"));
  expect(screen.queryByText("inbox-a")).not.toBeInTheDocument();
});

it.each(["status", "priority", "actor"] as const)("still applies the %s filter to a pinned archived row", async (filter) => {
  const fixture = archivedFixture();
  await openArchived(fixture);
  act(() => {
    const store = useInboxFilterStore.getState();
    if (filter === "status") {
      store.toggleStatusFilter("workspace-1", "todo");
      patchInboxIssueProjection(qc, "workspace-1", "issue-a", { status: "done" });
    } else if (filter === "priority") {
      store.togglePriorityFilter("workspace-1", "high");
      patchInboxIssueProjection(qc, "workspace-1", "issue-a", { priority: "low" });
    } else {
      store.toggleActorFilter("workspace-1", "agent:someone-else");
    }
  });
  await waitFor(() => expect(screen.queryByTestId("detail")).not.toBeInTheDocument());
  expect(screen.queryByText("inbox-a")).not.toBeInTheDocument();
  expect(replace).toHaveBeenLastCalledWith("/acme/inbox?view=archived");
});

// A server that pages two groups per request and applies the idle dimension
// when asked; `busy` holds the issues an agent works on. The task snapshot
// starts out matching it, as when another page already read it.
function idleServer(rows: InboxItem[], busy: Set<string>) {
  const isIdle = (row: InboxItem) => !!row.issue_id && !busy.has(row.issue_id);
  const listInboxPage = vi.fn(async (filters: InboxFilters, options: { groupId?: string }) => {
    const matching = rows.filter((row) => !filters.idleOnly || isIdle(row));
    if (options.groupId) return page(matching.filter((row) => (row.issue_id ?? row.id) === options.groupId));
    return page(matching.slice(0, 2));
  });
  const tasks = () => [...busy].map((issueId) => ({ id: `task-${issueId}`, agent_id: "agent-1", issue_id: issueId, status: "running" }) as AgentTask);
  setApiInstance({ listInboxPage, getAgentTaskSnapshot: async () => tasks(), getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  qc.setQueryData(agentTaskSnapshotOptions("workspace-1").queryKey, tasks());
  return {
    pageReads: () => listInboxPage.mock.calls.filter((call) => !call[1].groupId).length,
    // The snapshot changes, and the re-read it starts has settled by return.
    taskEvent: async (next: string[]) => {
      act(() => {
        busy.clear();
        for (const issueId of next) busy.add(issueId);
        qc.setQueryData(agentTaskSnapshotOptions("workspace-1").queryKey, tasks());
      });
      await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
    },
  };
}

// Production's gcTime: the held idle caches are what a return visit reuses.
const keepCaches = () => qc.setDefaultOptions({ queries: { retry: false, staleTime: Infinity, gcTime: 10 * 60 * 1000 }, mutations: { retry: false } });

it("re-reads the idle inbox as agents start and finish, keeping the open row until the selection moves", async () => {
  // The server filters the idle view, so an agent starting on the open issue
  // drops its row from the next page read, and an issue whose agent finished
  // can only appear through a re-read.
  const store = useInboxFilterStore.getState();
  store.toggleUnreadOnly("workspace-1");
  store.toggleIdleOnly("workspace-1");
  const { pageReads, taskEvent } = idleServer([item({ read: true }), item({ id: "inbox-b", issue_id: "issue-b", read: true })], new Set(["issue-b"]));

  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  expect(screen.queryByText("inbox-b")).not.toBeInTheDocument();
  expect(await screen.findByTestId("detail")).toHaveTextContent("issue-a");
  const readsBefore = pageReads();

  // An agent starts on the open issue: the re-read drops it, the pin keeps it.
  await taskEvent(["issue-a", "issue-b"]);
  await waitFor(() => expect(pageReads()).toBe(readsBefore + 1));
  expect(screen.getByText("inbox-a")).toBeInTheDocument();
  expect(screen.getByTestId("detail")).toHaveTextContent("issue-a");
  expect(detailUnmounted).not.toHaveBeenCalled();

  // Issue b's agent finishes: only the re-read can list it.
  await taskEvent(["issue-a"]);
  expect(await screen.findByText("inbox-b")).toBeInTheDocument();
  expect(screen.getByText("inbox-a")).toBeInTheDocument();

  // Moving the selection releases the pin on the busy row.
  fireEvent.click(screen.getByText("inbox-b"));
  await waitFor(() => expect(screen.queryByText("inbox-a")).not.toBeInTheDocument());
  expect(screen.getByTestId("detail")).toHaveTextContent("issue-b");
});

it("re-reads a retained idle cache after the task finished while InboxPage was unmounted", async () => {
  // A task that ends often sends no inbox event (the agent already commented),
  // so a return visit must compare against what the cached pages were read under.
  keepCaches();
  const store = useInboxFilterStore.getState();
  store.toggleUnreadOnly("workspace-1");
  store.toggleIdleOnly("workspace-1");
  const rows = [item({ read: true }), item({ id: "inbox-b", issue_id: "issue-b", read: true })];
  let busy = true;
  const task = { id: "task-b", agent_id: "agent-1", issue_id: "issue-b", status: "running" } as AgentTask;
  const snapshotKey = agentTaskSnapshotOptions("workspace-1").queryKey;
  qc.setQueryData(snapshotKey, [task]);
  const listInboxPage = vi.fn(async () => page(rows.filter((row) => !busy || row.issue_id !== "issue-b")));
  setApiInstance({ listInboxPage, getAgentTaskSnapshot: async () => busy ? [task] : [], getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  const mounted = renderPage();
  await screen.findByText("inbox-a");
  mounted.unmount();
  busy = false;
  // The global task-event route refreshed the shared snapshot on another page.
  qc.setQueryData(snapshotKey, []);
  renderPage();
  await screen.findByText("inbox-a");
  // No inbox event happened. The retained server page should be re-read.
  await waitFor(() => expect(screen.queryByText("inbox-b")).toBeInTheDocument());
});

// Both first requests read the server before a task ended. TanStack answers
// the task event's invalidation during the snapshot's first load with the
// request already in flight, so the snapshot shows the busy issues from before
// the event and never changes again; the idle page must be read again anyway.
it.each(["page-first", "snapshot-first"])("lists a row the server re-read as idle when a task ends during the first loads (%s)", async (order) => {
  const store = useInboxFilterStore.getState();
  store.toggleUnreadOnly("workspace-1");
  store.toggleIdleOnly("workspace-1");
  const rows = [item({ read: true }), item({ id: "inbox-b", issue_id: "issue-b", read: true })];
  let busy = true;
  const firstPage = deferred<InboxPageData>();
  const firstSnapshot = deferred<AgentTask[]>();
  const task = { id: "task-b", agent_id: "agent-1", issue_id: "issue-b", status: "running" } as AgentTask;
  const listInboxPage = vi.fn(async () => listInboxPage.mock.calls.length === 1
    ? firstPage.promise : page(rows.filter((row) => !busy || row.issue_id !== "issue-b")));
  const getAgentTaskSnapshot = vi.fn(() => firstSnapshot.promise);
  setApiInstance({ listInboxPage, getAgentTaskSnapshot, getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  renderPage();
  await waitFor(() => expect(listInboxPage).toHaveBeenCalledOnce());
  await waitFor(() => expect(getAgentTaskSnapshot).toHaveBeenCalledOnce());
  busy = false;
  if (order === "page-first") await act(async () => firstPage.resolve(page([rows[0]!])));
  await act(async () => {
    const refresh = qc.invalidateQueries({ queryKey: agentTaskSnapshotOptions("workspace-1").queryKey });
    firstSnapshot.resolve([task]);
    await refresh;
  });
  if (order === "snapshot-first") await act(async () => firstPage.resolve(page([rows[0]!])));

  await waitFor(() => expect(screen.queryByText("inbox-b")).toBeInTheDocument());
  expect(getAgentTaskSnapshot).toHaveBeenCalledOnce();
  expect(listInboxPage).toHaveBeenCalledTimes(2);
});

it("replaces a busy pinned row from its lookup without duplication or detail unmount", async () => {
  const store = useInboxFilterStore.getState();
  store.toggleUnreadOnly("workspace-1");
  store.toggleIdleOnly("workspace-1");
  let rows = [item({ read: true })];
  let busy = false;
  const snapshotKey = agentTaskSnapshotOptions("workspace-1").queryKey;
  qc.setQueryData(snapshotKey, []);
  const listInboxPage = vi.fn(async (filters: InboxFilters, options: { groupId?: string }) =>
    page(rows.filter((row) => options.groupId ? row.issue_id === options.groupId : !filters.idleOnly || !busy)));
  setApiInstance({ listInboxPage, getAgentTaskSnapshot: async () => [], getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  const detail = await screen.findByTestId("detail");
  await act(async () => {
    busy = true;
    qc.setQueryData(snapshotKey, [{ id: "task-a", agent_id: "agent-1", issue_id: "issue-a", status: "running" } as AgentTask]);
  });
  await waitFor(() => expect(listInboxPage.mock.calls.filter(([_, options]) => !options.groupId)).toHaveLength(2));
  expect(screen.getAllByText("inbox-a")).toHaveLength(1);
  rows = [item({ id: "inbox-a-new", read: true, created_at: "2026-06-15T09:00:00Z" })];
  await act(async () => { await onInboxInvalidate(qc, "workspace-1"); });
  await screen.findByText("inbox-a-new");
  expect(screen.queryByText("inbox-a")).not.toBeInTheDocument();
  expect(screen.getAllByText("inbox-a-new")).toHaveLength(1);
  expect(screen.getByTestId("detail")).toBe(detail);
  expect(detailUnmounted).not.toHaveBeenCalled();
});

it("opens an idle group beyond the loaded pages under the idle filter and keeps it once an agent starts on it", async () => {
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
  const rows = ["a", "b", "c"].map((key) => item({ id: `inbox-${key}`, issue_id: `issue-${key}`, read: true }));
  const { taskEvent } = idleServer(rows, new Set());
  searchParams = new URLSearchParams("issue=issue-c");
  renderPage();

  expect(await screen.findByTestId("detail")).toHaveTextContent("issue-c");
  await taskEvent(["issue-c"]);
  await waitFor(() => expect(screen.getByText("inbox-c")).toBeInTheDocument());
  expect(screen.getByTestId("detail")).toHaveTextContent("issue-c");
  expect(detailUnmounted).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it("keeps a reopened busy row open under the idle filter instead of leaving the inbox for the issue page", async () => {
  // Reply from the open row, which starts an agent on it, then come back: the
  // idle page no longer lists it, and its lookup only says it exists.
  keepCaches();
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
  const { pageReads, taskEvent } = idleServer([item({ read: true }), item({ id: "inbox-b", issue_id: "issue-b", read: true })], new Set());
  const mounted = renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await screen.findByTestId("detail");
  const readsBefore = pageReads();
  await taskEvent(["issue-a"]);
  await waitFor(() => expect(pageReads()).toBe(readsBefore + 1));
  mounted.unmount();
  replace.mockClear();
  searchParams = new URLSearchParams("issue=issue-a");
  renderPage();

  expect(await screen.findByTestId("detail")).toHaveTextContent("issue-a");
  expect(screen.getByText("inbox-a")).toBeInTheDocument();
  expect(replace).not.toHaveBeenCalled();
});

it("clears a selected notification without an issue under the idle filter instead of opening a missing issue page", async () => {
  // A notification click selects `issue_id ?? id`; a group without an issue
  // is never idle, so the filter hides it.
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
  idleServer([item({ read: true }), item({ id: "inbox-system", issue_id: null, type: "autopilot_paused", read: true })], new Set());
  searchParams = new URLSearchParams("issue=inbox-system");
  renderPage();

  await waitFor(() => expect(replace).toHaveBeenLastCalledWith("/acme/inbox"));
  expect(replace).not.toHaveBeenCalledWith("/acme/issues/inbox-system");
});

it.each([false, true])("keeps a deep link's selection while its lookup has no answer yet (optimistic read on another row: %s)", async (markOtherRow) => {
  // Marking a row read cancels every inbox request, a lookup still on its
  // first load included, and patches every inbox cache. Until the write
  // settles and re-reads the lookup, there is no answer to fall back from.
  keepCaches();
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
  const a = item();
  const b = item({ id: "inbox-b", issue_id: "issue-b", read: true });
  const c = item({ id: "inbox-c", issue_id: "issue-c", read: true });
  qc.setQueryData(agentTaskSnapshotOptions("workspace-1").queryKey, []);
  const lookupGate = deferred<InboxPageData>();
  const writeGate = deferred<InboxItem>();
  const listInboxPage = vi.fn(async (_filters: InboxFilters, options: { groupId?: string }) =>
    options.groupId === "issue-c" ? lookupGate.promise : page([a, b]));
  const markInboxRead = vi.fn(() => writeGate.promise);
  setApiInstance({ listInboxPage, markInboxRead, getAgentTaskSnapshot: async () => [], getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  searchParams = new URLSearchParams("issue=issue-c");
  renderPage();
  await screen.findByText("inbox-a");
  await waitFor(() => expect(listInboxPage.mock.calls.some(([, options]) => options.groupId === "issue-c")).toBe(true));
  if (markOtherRow) {
    act(() => rowActions.onMarkRead("inbox-a"));
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledOnce());
  }
  // The server has still not answered for C.
  expect(replace).not.toHaveBeenCalled();
  await act(async () => {
    lookupGate.resolve(page([c]));
    writeGate.resolve({ ...a, read: true });
  });

  await waitFor(() => expect(screen.queryByTestId("detail")).toHaveTextContent("issue-c"));
  expect(replace).not.toHaveBeenCalled();
});

it("keeps the detail of an idle row opened on a return visit when an agent starts on it before the mount's re-read settles", async () => {
  keepCaches();
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
  const a = item({ read: true });
  const b = item({ id: "inbox-b", issue_id: "issue-b", read: true });
  const idle = { ...EMPTY_INBOX_FILTERS, idleOnly: true };
  // The idle page an earlier visit read, while A was idle.
  qc.setQueryData(inboxPagesOptions("workspace-1", idle).queryKey, { pages: [page([a, b])], pageParams: [null] });
  const snapshotKey = agentTaskSnapshotOptions("workspace-1").queryKey;
  qc.setQueryData(snapshotKey, []);
  let busy = false;
  const mountReread = deferred<InboxPageData>();
  const listInboxPage = vi.fn(async (filters: InboxFilters, options: { groupId?: string }) => {
    const rows = [a, b].filter((row) => !filters.idleOnly || !busy || row.issue_id !== "issue-a");
    if (options.groupId) return page(rows.filter((row) => row.issue_id === options.groupId));
    return !busy ? mountReread.promise : page(rows);
  });
  setApiInstance({ listInboxPage, getAgentTaskSnapshot: async () => [], getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  renderPage();
  await waitFor(() => expect(listInboxPage).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText("inbox-a"));
  const detail = await screen.findByTestId("detail");
  expect(detail).toHaveTextContent("issue-a");
  // Replying from the detail starts an agent before the mount's re-read lands.
  await act(async () => {
    busy = true;
    qc.setQueryData(snapshotKey, [{ id: "task-a", agent_id: "agent-1", issue_id: "issue-a", status: "running" } as AgentTask]);
  });
  await waitFor(() => expect(listInboxPage.mock.calls.filter(([, options]) => !options.groupId).length).toBeGreaterThan(1));
  await act(async () => mountReread.resolve(page([a, b])));
  const pageRows = () => qc.getQueryData(inboxPagesOptions("workspace-1", idle).queryKey)?.pages.flatMap((p) => p.items);
  await waitFor(() => expect(pageRows()?.map((row) => row.id)).toEqual(["inbox-b"]));

  expect(screen.getByText("inbox-a")).toBeInTheDocument();
  expect(screen.queryByTestId("detail")).toBe(detail);
  expect(detailUnmounted).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenLastCalledWith("/acme/inbox");
});

it("does not re-read the idle pages when the task snapshot changes order but not its busy issues", async () => {
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
  const { pageReads } = idleServer([item({ read: true })], new Set(["issue-b", "issue-c"]));
  renderPage();
  await screen.findByText("inbox-a");
  await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
  const before = pageReads();
  await act(async () => qc.setQueryData(agentTaskSnapshotOptions("workspace-1").queryKey, [
    { id: "task-issue-c", agent_id: "agent-1", issue_id: "issue-c", status: "running" },
    { id: "task-issue-b", agent_id: "agent-1", issue_id: "issue-b", status: "running" },
  ] as AgentTask[]));
  expect(pageReads()).toBe(before);
});

it("shows the load error and no pending selection when a deep link's first page fails", async () => {
  // The lookup waits for the page, so it is pending without a request of its
  // own; the error card is the page's whole answer.
  const listInboxPage = vi.fn(async (_filters: InboxFilters, _options: { groupId?: string }) => {
    throw new Error("offline");
  });
  setApiInstance({ listInboxPage, getInboxUnreadSummary: async () => [] } as unknown as ApiClient);
  searchParams = new URLSearchParams("issue=issue-a");
  const { container } = renderPage();

  await waitFor(() => expect(container.querySelector(".py-16 button")).not.toBeNull());
  expect(screen.queryByRole("status")).toBeNull();
  expect(listInboxPage.mock.calls.some(([, options]) => options?.groupId)).toBe(false);
  expect(replace).not.toHaveBeenCalled();
});

it("keeps an inbox event's invalidation on the open row's lookup when the idle seed rewrites it", async () => {
  // Writing the seed would otherwise mark the lookup fresh, and the row the idle
  // page drops next would keep its fields from before the event.
  useInboxFilterStore.getState().toggleUnreadOnly("workspace-1");
  useInboxFilterStore.getState().toggleIdleOnly("workspace-1");
  const rows = [item({ read: true })];
  idleServer(rows, new Set());
  renderPage();
  fireEvent.click(await screen.findByText("inbox-a"));
  await screen.findByTestId("detail");
  const lookupKey = inboxLookupOptions("workspace-1", "issue-a").queryKey;
  await waitFor(() => expect(qc.getQueryData(lookupKey)?.items[0]?.title).toBe("Issue title"));

  rows[0] = { ...rows[0]!, title: "Renamed" };
  await act(async () => { await onInboxInvalidate(qc, "workspace-1"); });

  await waitFor(() => expect(qc.getQueryData(lookupKey)?.items[0]?.title).toBe("Renamed"));
  expect(qc.getQueryState(lookupKey)?.isInvalidated).toBe(true);
});
