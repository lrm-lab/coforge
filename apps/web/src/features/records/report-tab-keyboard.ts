export function adjacentReportTabId(
  ids: readonly string[],
  current: string,
  backward: boolean,
): string | null {
  const index = ids.indexOf(current);
  if (index < 0) return null;
  const next = backward ? index - 1 : index + 1;
  if (next < 0 || next >= ids.length) return null;
  return ids[next] ?? null;
}

export function nextReportTabIdFromKey(
  ids: readonly string[],
  current: string,
  key: string,
  shiftKey: boolean,
): string | null {
  if (ids.length <= 1) return null;
  if (key === "Tab") return adjacentReportTabId(ids, current, shiftKey);
  const index = ids.indexOf(current);
  if (index < 0) return null;
  if (key === "ArrowRight") return ids[(index + 1) % ids.length] ?? null;
  if (key === "ArrowLeft") return ids[(index - 1 + ids.length) % ids.length] ?? null;
  if (key === "Home") return ids[0] ?? null;
  if (key === "End") return ids[ids.length - 1] ?? null;
  return null;
}
