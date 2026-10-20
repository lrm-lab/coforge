/** RFC 6749 §5.1–5.2, RFC 6750 §5.3: an answer carrying or refusing a credential is never cached
 * (`Pragma` for HTTP/1.0 caches). */
export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;
