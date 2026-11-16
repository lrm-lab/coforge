import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";

/**
 * What opens a web-page artifact. Two signed values, each with its own purpose, so neither reads
 * as the other, a session, or any other signed value (`signed-value.server.ts`):
 *
 * - The ticket opens one page once, on one origin. The application checks that the reader may
 *   read the page, then signs what it allowed: this artifact, at this version, for this reader,
 *   framed by this application origin, served from this exact page origin, until a short expiry,
 *   with a nonce that is spent when the ticket is used (`artifact-sandbox-nonces.server.ts`).
 * - The file token is what the ticket becomes once spent: the prefix of the page's own files
 *   (`/_f/<token>/<path>`). It names the same artifact, version, reader and origins, and is good
 *   for `SANDBOX_FILE_TTL_SECONDS`. It is a path, not a cookie, because the page is framed by
 *   another site and a browser may refuse that frame its cookies.
 */
export type SandboxGrant = {
  /** Workspace */
  w: string;
  /** Artifact */
  a: string;
  /** Version number: a link opens exactly one version. */
  v: number;
  /** The reader (a person) */
  u: string;
  /** The application origin that may frame the page (`frame-ancestors`). */
  o: string;
  /** The page origin that may use this value: `a-<uuid>` under the sandbox host. */
  s: string;
  /** When it was made, seconds since the epoch. */
  iat: number;
  /** When it stops opening, seconds since the epoch. */
  exp: number;
};

export type SandboxTicket = SandboxGrant & {
  /** Spent once, whatever else holds. */
  n: string;
};

export type SandboxFileToken = SandboxGrant;

/** How long a ticket opens its page: long enough to load the frame, short enough that a link
 * copied out of the page is dead. The app asks for a new one each time it shows a page. */
export const SANDBOX_TICKET_TTL_SECONDS = 2 * 60;

/** How long the files under a ticket keep opening, counted from when the ticket was spent: long
 * enough for a lazy image or a click to another page of the artifact soon after it loaded, short
 * enough that a copied file URL stops working while the reader is still looking. */
export const SANDBOX_FILE_TTL_SECONDS = 10 * 60;

type GrantInput = Omit<SandboxGrant, "iat" | "exp">;

const epochSeconds = (now: Date) => Math.floor(now.getTime() / 1000);

export function signSandboxTicket(
  input: GrantInput,
  secret: string,
  now: Date,
): { ticket: string; expiresAt: Date } {
  const iat = epochSeconds(now);
  const exp = iat + SANDBOX_TICKET_TTL_SECONDS;
  const claims: SandboxTicket = { ...input, n: crypto.randomUUID(), iat, exp };
  return {
    ticket: signValue("artifact-sandbox-ticket", claims, secret),
    expiresAt: new Date(exp * 1000),
  };
}

export function signSandboxFileToken(input: GrantInput, secret: string, now: Date): string {
  const iat = epochSeconds(now);
  const claims: SandboxFileToken = { ...input, iat, exp: iat + SANDBOX_FILE_TTL_SECONDS };
  return signValue("artifact-sandbox-files", claims, secret);
}

/** The ticket's claims when it is one we signed, expired or not (a used or expired link still
 * says who may frame it); null when it is not one we signed, or not the shape we sign. */
export function readSandboxTicket(value: string, secret: string): SandboxTicket | null {
  const payload = readSignedValue<Partial<SandboxTicket>>("artifact-sandbox-ticket", value, secret);
  if (!payload || !isGrant(payload)) return null;
  const nonce = (payload as { n?: unknown }).n;
  return typeof nonce === "string" && nonce ? (payload as SandboxTicket) : null;
}

export function readSandboxFileToken(value: string, secret: string): SandboxFileToken | null {
  const payload = readSignedValue<Partial<SandboxFileToken>>(
    "artifact-sandbox-files",
    value,
    secret,
  );
  return payload && isGrant(payload) ? payload : null;
}

export const sandboxGrantExpired = (grant: SandboxGrant, now: Date) =>
  grant.exp * 1000 <= now.getTime();

function isGrant(value: Partial<SandboxGrant>): value is SandboxGrant {
  return (
    typeof value.w === "string" &&
    typeof value.a === "string" &&
    typeof value.u === "string" &&
    typeof value.o === "string" &&
    typeof value.s === "string" &&
    Number.isSafeInteger(value.v) &&
    (value.v ?? 0) > 0 &&
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp)
  );
}
