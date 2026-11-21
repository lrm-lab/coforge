const ELLIPSIS = "…";

function middleTruncateText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  if (maxLength <= 1) return ELLIPSIS;
  const available = maxLength - 1;
  const tailLength = Math.ceil(available * 0.55);
  const headLength = available - tailLength;
  return `${chars.slice(0, headLength).join("")}${ELLIPSIS}${chars.slice(chars.length - tailLength).join("")}`;
}

export function middleTruncatePath(path: string, maxLength = 42): string {
  if (Array.from(path).length <= maxLength) return path;
  const segments = path.split("/");
  if (segments.length <= 1) return middleTruncateText(path, maxLength);

  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const lastLength = Array.from(last).length;
  const ellipsisPrefixLength = 2;

  if (lastLength + ellipsisPrefixLength >= maxLength) {
    return middleTruncateText(path, maxLength);
  }

  const tailSegments = [last];
  let tailLength = lastLength;
  for (let i = segments.length - 2; i >= 1; i--) {
    const candidate = segments[i]!;
    const candidateLength = Array.from(candidate).length + 1;
    const minPrefix = first ? Math.min(Array.from(first).length, 4) + 1 : 0;
    if (minPrefix + ellipsisPrefixLength + tailLength + candidateLength <= maxLength) {
      tailSegments.unshift(candidate);
      tailLength += candidateLength;
    } else {
      break;
    }
  }

  const tail = tailSegments.join("/");
  const prefixBudget = maxLength - tailLength - ellipsisPrefixLength;
  if (prefixBudget <= 0) return `${ELLIPSIS}/${tail}`;

  const firstChars = Array.from(first);
  const prefix =
    firstChars.length + 1 <= prefixBudget
      ? `${first}/`
      : firstChars.slice(0, prefixBudget).join("");
  return `${prefix}${ELLIPSIS}/${tail}`;
}
