import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";

/** How long a sealed request stays readable: the time of one redirect. */
const SEALED_QUERY_TTL_SECONDS = 5 * 60;

/** An authorization request's raw query, signed with the session secret. */
export function sealQuery(query: string, secret: string, now: Date): string {
  const exp = Math.floor(now.getTime() / 1000) + SEALED_QUERY_TTL_SECONDS;
  return signValue("authorization-query", { query, exp }, secret);
}

/** The raw query `sealed` carries, when the server signed it and it has not expired. */
export function openQuery(sealed: string, secret: string, now: Date): string | undefined {
  const value = readSignedValue<{ query: string; exp: number }>(
    "authorization-query",
    sealed,
    secret,
  );
  if (!value || typeof value.query !== "string" || typeof value.exp !== "number") return undefined;
  return value.exp * 1000 > now.getTime() ? value.query : undefined;
}
