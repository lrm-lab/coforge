/** Keep Bun's implicit string-body type when Start or middleware re-wraps the body as a stream. */
export function textResponse(body: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(body, { ...init, headers });
}
