/** What both host HTTP adapters read from a request: the bearer token the cluster authenticates
 * with, and a JSON body that must be an object. The one rule, so the two routes cannot disagree on
 * what a malformed request or a missing token looks like. */

export function bearerToken(request: Request): string | undefined {
  const match = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

/** The request's JSON body when it is an object, and `undefined` for anything else — a missing
 * body, invalid JSON, an array or a primitive all read as "no object". */
export async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    return body as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
