import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";

/** What `task list --status` takes as a single value: every status, or one of them. */
const TASK_LIST_STATUSES = ["all", ...TASK_STATUSES] as const;

/**
 * `task list --status`'s value checked (task #506): `all` or one status as before, or several
 * statuses comma-separated, which ask for exactly those in the board's column order. Returns the
 * single value or the list; a wrong value is the `message` to refuse with.
 */
export function parseTaskListStatus(
  raw: string | undefined,
): { status?: TaskStatus | "all"; statuses?: TaskStatus[] } | { message: string } {
  if (raw === undefined) return {};
  if (!raw.includes(",")) {
    if (!(TASK_LIST_STATUSES as readonly string[]).includes(raw))
      return { message: `--status must be one of ${TASK_LIST_STATUSES.join("|")}; got ${raw}` };
    return { status: raw as TaskStatus | "all" };
  }
  const parts = raw.split(",");
  const known = new Set<string>(TASK_STATUSES);
  if (parts.some((part) => !known.has(part)) || new Set(parts).size !== parts.length)
    return {
      message: `--status takes one of ${TASK_LIST_STATUSES.join("|")}, or several of ${TASK_STATUSES.join("|")} comma-separated; got ${raw}`,
    };
  return { statuses: TASK_STATUSES.filter((status) => parts.includes(status)) };
}
