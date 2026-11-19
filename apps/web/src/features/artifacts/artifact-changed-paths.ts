import { m } from "#src/paraglide/messages";

export function formatChangedPaths(
  changedPaths: readonly string[],
  changedCount: number,
  maxShown = changedPaths.length,
): string | undefined {
  if (changedPaths.length === 0) return undefined;
  const shown = changedPaths.slice(0, Math.max(1, maxShown));
  const remaining = Math.max(0, changedCount - shown.length);
  const files =
    remaining > 0
      ? m.av_update_changed_more({ files: shown.join(", "), count: remaining })
      : shown.join(", ");
  return m.av_update_changed({ files });
}
