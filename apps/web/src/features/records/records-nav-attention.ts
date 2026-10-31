import { queryOptions } from "@tanstack/react-query";

import { loadRecordsNavAttention } from "./records.functions";

/**
 * The Records rail dot: a Leader's preview hour, or an unread member assignment. A query of its
 * own rather than part of the Workspace layout's read, so a change in Records refreshes it
 * (`useRecordRefresh().records()`) without reading the whole Workspace layout again (task #366).
 */
export const recordsNavAttentionQuery = (workspaceSlug: string) =>
  queryOptions({
    queryKey: ["records", workspaceSlug, "nav-attention"],
    queryFn: () => loadRecordsNavAttention().catch(() => ({ preview: false })),
  });
