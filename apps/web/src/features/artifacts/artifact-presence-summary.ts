export type PresenceSummaryPart =
  | { kind: "viewing"; count: number }
  | { kind: "you" }
  | { kind: "sawLatest"; count: number };

export function presenceSummary({
  othersViewing,
  youViewing,
  seenLatest,
}: {
  othersViewing: number;
  youViewing: boolean;
  seenLatest: number;
}): PresenceSummaryPart[] {
  if (othersViewing === 0 && seenLatest === 0) return [];
  const parts: PresenceSummaryPart[] = [];
  if (othersViewing > 0) parts.push({ kind: "viewing", count: othersViewing });
  if (youViewing) parts.push({ kind: "you" });
  if (seenLatest > 0) parts.push({ kind: "sawLatest", count: seenLatest });
  return parts;
}
