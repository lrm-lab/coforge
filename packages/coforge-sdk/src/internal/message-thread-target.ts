/** A thread target split into parent and root, or `undefined` for a top-level target.
 * The colon after `attachment` belongs to its namespace, not its thread. */
const splitThreadTarget = (target: string): [parent: string, root: string] | undefined => {
  const index = target.indexOf(":", target.startsWith("attachment:") ? "attachment:".length : 0);
  return index === -1 ? undefined : [target.slice(0, index), target.slice(index + 1)];
};
/**
 * The parent of a thread target (before its thread separator), or `undefined` for a
 * top-level target. `#general:12345678` → `#general`; `@frank:12345678` → `@frank`; `#general` →
 * `undefined`.
 */
export const threadParentTarget = (target: string): string | undefined =>
  splitThreadTarget(target)?.[0];
/**
 * The root of a thread target (after its thread separator), or `undefined` for a top-level
 * target. `#general:12345678` → `12345678`; `#general` → `undefined`.
 */
export const threadRootTarget = (target: string): string | undefined =>
  splitThreadTarget(target)?.[1];
