import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";

/**
 * The short-lived link a web-page artifact is opened with (task #490). The sandbox origin carries
 * none of our cookies, so it cannot ask who is reading: the application checks that, then signs
 * what it allowed — this artifact, at this version, for this reader, framed by this origin, until
 * then — and the sandbox only checks the signature (and the reader's access once more).
 *
 * Signed like the session, under its secret, with its own purpose: a ticket never reads as a
 * session or any other signed value (`signed-value.server.ts`).
 */
export type SandboxTicket = {
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
  /** Expiry, seconds since the epoch. */
  exp: number;
};

/** How long a link opens its page. Long enough to load it, short enough that a link copied out
 * of the page stops working soon after; the pane asks for a new one each time it shows a page. */
export const SANDBOX_TICKET_TTL_SECONDS = 5 * 60;

export function signSandboxTicket(
  input: Omit<SandboxTicket, "exp">,
  secret: string,
  now: Date,
): { ticket: string; expiresAt: Date } {
  const exp = Math.floor(now.getTime() / 1000) + SANDBOX_TICKET_TTL_SECONDS;
  return {
    ticket: signValue("artifact-sandbox", { ...input, exp }, secret),
    expiresAt: new Date(exp * 1000),
  };
}

/** The ticket's grant, `expired` past its expiry, or null when it is not one we signed (or not
 * the shape we sign). */
export function readSandboxTicket(
  value: string,
  secret: string,
  now: Date,
): SandboxTicket | "expired" | null {
  const payload = readSignedValue<Partial<SandboxTicket>>("artifact-sandbox", value, secret);
  if (!payload || !isTicket(payload)) return null;
  return payload.exp * 1000 <= now.getTime() ? "expired" : payload;
}

function isTicket(value: Partial<SandboxTicket>): value is SandboxTicket {
  return (
    typeof value.w === "string" &&
    typeof value.a === "string" &&
    typeof value.u === "string" &&
    typeof value.o === "string" &&
    Number.isSafeInteger(value.v) &&
    (value.v ?? 0) > 0 &&
    Number.isSafeInteger(value.exp)
  );
}
