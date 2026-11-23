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
