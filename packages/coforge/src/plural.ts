/** `1 version`, `2 versions`: a count with its noun, the noun made plural by an `s`. */
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
