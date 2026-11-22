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

function findLastVersionSpan(stemChars: readonly string[]): { start: number; end: number } | null {
  const stem = stemChars.join("");
  const pattern = /v?\d+/gi;
  let lastMatch: RegExpExecArray | null = null;
  let match = pattern.exec(stem);
  while (match !== null) {
    lastMatch = match;
    match = pattern.exec(stem);
  }
  if (!lastMatch) return null;
  const start = Array.from(stem.slice(0, lastMatch.index)).length;
  const length = Array.from(lastMatch[0]).length;
  return { start, end: start + length };
}

function middleTruncateBasename(name: string, maxLength: number): string {
  const nameChars = Array.from(name);
  if (nameChars.length <= maxLength) return name;
  if (maxLength <= 1) return ELLIPSIS;

  const dot = name.lastIndexOf(".");
  const rawExt = dot > 0 ? name.slice(dot) : "";
  const extChars = Array.from(rawExt);
  const hasExt = extChars.length > 0 && extChars.length <= 10 && extChars.length < maxLength - 4;
  const ext = hasExt ? rawExt : "";
  const stem = hasExt ? name.slice(0, dot) : name;
  const stemChars = Array.from(stem);
  const stemBudget = maxLength - (hasExt ? extChars.length : 0);
  if (stemBudget <= 1) return middleTruncateText(name, maxLength);

  const available = stemBudget - 1;
  const tailLength = Math.ceil(available * 0.55);
  const headLength = available - tailLength;
  const versionSpan = findLastVersionSpan(stemChars);

  if (
    versionSpan &&
    versionSpan.end > headLength &&
    versionSpan.start < stemChars.length - tailLength
  ) {
    const rawToken = stemChars.slice(versionSpan.start, versionSpan.end);
    const token = rawToken.length > 8 ? rawToken.slice(rawToken.length - 8) : rawToken;
    const tokenStart = versionSpan.end - token.length;
    if (stemBudget >= token.length + 6) {
      const remaining = stemBudget - token.length - 2;
      let tailBudget = Math.min(
        Math.max(2, Math.floor(remaining * 0.45)),
        stemChars.length - versionSpan.end,
      );
      let headBudget = Math.min(remaining - tailBudget, tokenStart);
      tailBudget = Math.min(remaining - headBudget, stemChars.length - versionSpan.end);
      if (headBudget > 0 && tailBudget > 0) {
        const headText = stemChars.slice(0, headBudget).join("");
        const tailText = stemChars.slice(stemChars.length - tailBudget).join("");
        return `${headText}${ELLIPSIS}${token.join("")}${ELLIPSIS}${tailText}${ext}`;
      }
    }
  }

  const headText = stemChars.slice(0, headLength).join("");
  const tailText = stemChars.slice(stemChars.length - tailLength).join("");
  return `${headText}${ELLIPSIS}${tailText}${ext}`;
}

export function middleTruncatePath(path: string, maxLength = 42): string {
  if (Array.from(path).length <= maxLength) return path;
  const segments = path.split("/");
  if (segments.length <= 1) return middleTruncateBasename(path, maxLength);

  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const lastLength = Array.from(last).length;
  const ellipsisPrefixLength = 2;

  if (lastLength + ellipsisPrefixLength >= maxLength) {
    if (maxLength <= 12) return middleTruncateBasename(last, maxLength);
    const firstChars = Array.from(first);
    const maxDirBudget = Math.max(2, Math.floor(maxLength * 0.26));
    const dirPrefix =
      firstChars.length > 0 && firstChars.length + 3 <= maxDirBudget
        ? `${first}/${ELLIPSIS}/`
        : firstChars.length > 0 && maxDirBudget >= 6
          ? `${firstChars.slice(0, maxDirBudget - 2).join("")}${ELLIPSIS}/`
          : `${ELLIPSIS}/`;
    return `${dirPrefix}${middleTruncateBasename(last, maxLength - Array.from(dirPrefix).length)}`;
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
