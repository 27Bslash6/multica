import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { refreshInboxIdleQueries } from "@multica/core/inbox/ws-updaters";
import { deriveIssueSurfaceActivity } from "../../issues/surface/activity";

/**
 * Re-reads the server's idle-filtered inbox pages for every view that lists
 * them: the Inbox page, and its peek from another space while the page is
 * closed.
 *
 * The task snapshot only says when to ask the server again: on this mount's
 * first snapshot, and whenever the issues an agent is running or queued on
 * (the activity badge's rule) change. Each mount asks once, because a task
 * that ended while the inbox was closed often sends no inbox event, and the
 * cached idle pages and snapshot may both predate it.
 */
export function useInboxIdleRefresh(wsId: string) {
  const queryClient = useQueryClient();
  const { data: taskSnapshot } = useQuery(agentTaskSnapshotOptions(wsId));
  const busyIssues = useMemo(
    () => taskSnapshot && [...deriveIssueSurfaceActivity(taskSnapshot).activityByIssueId.keys()].sort().join(","),
    [taskSnapshot],
  );
  useEffect(() => {
    if (busyIssues !== undefined) void refreshInboxIdleQueries(queryClient, wsId);
  }, [busyIssues, queryClient, wsId]);
}
