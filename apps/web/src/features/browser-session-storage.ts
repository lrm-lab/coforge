/**
 * The browser's session storage, or `undefined` when there is none to use.
 *
 * `sessionStorage` is absent during SSR, and even reaching for it can throw outright when storage
 * is blocked (private mode, partitioned contexts), so absence is a normal answer here rather than
 * an error: callers fall back to their defaults. The local-storage twin is `browser-local-storage`.
 */
export type BrowserSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserSessionStorage(): BrowserSessionStorage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}
