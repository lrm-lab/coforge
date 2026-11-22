function middleTruncateSegment(segment: string, maxChars: number): string {
  if (segment.length <= maxChars) return segment;
  if (maxChars <= 3) return segment.slice(-maxChars);
  const tailLen = Math.ceil((maxChars - 1) * 0.6);
  const headLen = maxChars - 1 - tailLen;
  return `${segment.slice(0, headLen)}…${segment.slice(-tailLen)}`;
}

export function formatDisplayPath(rawPath: string, maxLength = 56): string {
  if (rawPath.length <= maxLength) return rawPath;
  const sep = rawPath.includes("\\") && !rawPath.includes("/") ? "\\" : "/";
  const parts = rawPath.split(sep);
  if (parts.length <= 2) return middleTruncateSegment(rawPath, maxLength);

  const hasLeadingSep = parts[0] === "";
  const isDrive = /^[A-Za-z]:$/.test(parts[0]!);
  const rootSlots = hasLeadingSep || isDrive ? 2 : 1;
  const leadingRoot = hasLeadingSep
    ? `${sep}${parts[1] ?? ""}`
    : isDrive
      ? `${parts[0]}${sep}${parts[1] ?? ""}`
      : parts[0]!;

  const rest = parts.slice(rootSlots);
  if (rest.length === 0) return middleTruncateSegment(rawPath, maxLength);

  const prefix = middleTruncateSegment(leadingRoot, Math.min(12, Math.floor(maxLength * 0.25)));
  const tailBudget = Math.max(24, maxLength - prefix.length - 3);

  const minTailCount = Math.min(rest.length, 3);
  const tailSegments = rest.slice(-minTailCount).map((seg, idx, arr) => {
    const perSeg =
      idx === arr.length - 1
        ? Math.max(16, Math.floor(tailBudget * 0.5))
        : Math.max(12, Math.floor(tailBudget / arr.length));
    return middleTruncateSegment(seg, perSeg);
  });

  let tail = tailSegments.join(sep);
  for (let i = rest.length - minTailCount - 1; i >= 0; i -= 1) {
    const candidate = `${rest[i]}${sep}${tail}`;
    if (candidate.length > tailBudget) break;
    tail = candidate;
  }

  if (rest.length <= minTailCount && `${prefix}${sep}${tail}`.length <= maxLength) {
    return `${prefix}${sep}${tail}`;
  }
  return `${prefix}${sep}…${sep}${tail}`;
}
