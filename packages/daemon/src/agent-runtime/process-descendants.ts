import type { OwnedProcessIdentity } from "@lrm/coforge-anvil";
import { hostProcessTable, type ProcessTable } from "#src/platform/process-tree";

export type LiveDescendantsOptions = Readonly<{
  processTable?: ProcessTable;
  startedAfterMs?: number;
}>;

/**
 * Counts live OS descendants of `rootPid`, or `undefined` when the root is absent or the host
 * process table cannot observe it (for example on Windows, where `psProcessTable` is empty, or on
 * an embedded mock session with no child PID). Callers treat `undefined` as unknown, never as
 * zero, so an unobservable tree never falsely claims a tool or background task has exited.
 */
export async function countLiveProcessDescendants(
  rootPid: number | undefined,
  options: LiveDescendantsOptions = {},
): Promise<number | undefined> {
  if (rootPid === undefined) return undefined;
  const processTable = options.processTable ?? hostProcessTable;
  let table: readonly OwnedProcessIdentity[];
  try {
    table = await processTable.list();
  } catch {
    return undefined;
  }
  const main = table.find((entry) => entry.pid === rootPid);
  if (!main) return undefined;
  const byParent = new Map<number, OwnedProcessIdentity[]>();
  for (const proc of table) {
    let children = byParent.get(proc.ppid);
    if (!children) {
      children = [];
      byParent.set(proc.ppid, children);
    }
    children.push(proc);
  }
  const descendants: OwnedProcessIdentity[] = [];
  const seen = new Set<number>([main.pid]);
  const queue = [...(byParent.get(main.pid) ?? [])];
  while (queue.length > 0) {
    const proc = queue.shift()!;
    if (seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    descendants.push(proc);
    const children = byParent.get(proc.pid);
    if (children) queue.push(...children);
  }
  if (options.startedAfterMs === undefined) return descendants.length;
  const resolutionMs = processTable.resolutionMs ?? 1_000;
  const fenceMs = Math.floor(options.startedAfterMs / resolutionMs) * resolutionMs;
  return descendants.filter((entry) => entry.startedAtMs >= fenceMs).length;
}
