/**
 * How well a name matches a lower-cased query, or `undefined` when it does not match at all.
 * Lower is better: 0 exact, 1 a prefix of the label or any other field, 2 a later label word's
 * prefix (e.g. a surname), 3 any other substring hit. Everything is compared case-insensitively.
 * The @-mention list and the search page's matches rank by it.
 */
export function nameMatchTier(
  label: string,
  others: readonly string[],
  lowerQuery: string,
): 0 | 1 | 2 | 3 | undefined {
  const lowerLabel = label.toLowerCase();
  if (lowerLabel === lowerQuery) return 0;
  let hasPrefix = lowerLabel.startsWith(lowerQuery);
  let otherContainsQuery = false;
  // An exact match in another field still outranks a label prefix.
  for (const other of others) {
    const field = other.toLowerCase();
    if (field === lowerQuery) return 0;
    if (!hasPrefix) {
      if (field.startsWith(lowerQuery)) hasPrefix = true;
      else if (!otherContainsQuery) otherContainsQuery = field.includes(lowerQuery);
    }
  }
  if (hasPrefix) return 1;

  // A later word cannot match when the complete label contains no query.
  if (!lowerLabel.includes(lowerQuery)) return otherContainsQuery ? 3 : undefined;

  let firstWord = true;
  for (const word of lowerLabel.split(/\s+/)) {
    if (!word) continue;
    if (firstWord) {
      firstWord = false;
      continue;
    }
    if (word.startsWith(lowerQuery)) return 2;
  }
  return 3;
}
