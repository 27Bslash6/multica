import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { useInboxFilterStore, type InboxFilters } from "@multica/core/inbox/filter-store";
import { archivedInboxLookupOptions, inboxKeys } from "@multica/core/inbox/queries";
import { onInboxInvalidate, onInboxIssueDeleted, patchInboxIssueProjection } from "@multica/core/inbox/ws-updaters";
import type { InboxPage as InboxPageData } from "@multica/core/types/inbox";
import type { InboxItem } from "@multica/core/types";
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
