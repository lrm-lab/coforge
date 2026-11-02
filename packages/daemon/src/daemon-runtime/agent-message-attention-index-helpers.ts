export const byNumber = (left: number, right: number) => left - right;

export function isAscending(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i]! < values[i - 1]!) return false;
  return true;
}

/** The index of the first value above `bound` in an ascending list. */
export function firstAbove(values: readonly number[], bound: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= bound) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether two thread roots name the same message: compared without case, and a short (8-hex)
 * root names the full root it begins. */
export function sameThreadRoot(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || (a.length < b.length ? b.startsWith(a) : a.startsWith(b));
}

/** Whether an ascending list holds `value`. */
export function containsSorted(values: readonly number[] | undefined, value: number): boolean {
  if (!values?.length) return false;
  const index = firstAbove(values, value - 1);
  return values[index] === value;
}
