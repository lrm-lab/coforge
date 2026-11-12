import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";

/**
 * The short-lived link a web-page artifact is opened with (task #490). The sandbox origin carries
 * none of our cookies, so it cannot ask who is reading: the application checks that, then signs
 * what it allowed — this artifact, at this version, for this reader, framed by this origin, until
 * then — and the sandbox only checks the signature (and the reader's access once more).
 *
 * A ticket opens the wrapper for `SANDBOX_TICKET_TTL_SECONDS` and the page's files (what it loads,
 * the pages it links to) for `SANDBOX_FILE_TTL_SECONDS`, both counted from when it was made.
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
  /** When it was made, seconds since the epoch: the wrapper opens for `SANDBOX_TICKET_TTL_SECONDS`
   * after it. */
  iat: number;
  /** When its files stop opening, seconds since the epoch: `SANDBOX_FILE_TTL_SECONDS` after it
   * was made. */
  exp: number;
};

/** How long a link opens its wrapper. Long enough to load it, short enough that a link copied out
 * of the page stops working soon after; the pane asks for a new one each time it shows a page. */
export const SANDBOX_TICKET_TTL_SECONDS = 5 * 60;

/** How long the files under a link keep opening, once it was made: a reading session's worth, for
 * a lazy image or a click to another page of the artifact. One constant for every file. */
export const SANDBOX_FILE_TTL_SECONDS = 30 * 60;

export function signSandboxTicket(
  input: Omit<SandboxTicket, "iat" | "exp">,
  secret: string,
  now: Date,
): { ticket: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  return {
    ticket: signValue(
      "artifact-sandbox",
      { ...input, iat, exp: iat + SANDBOX_FILE_TTL_SECONDS },
      secret,
    ),
    // When the link itself (its wrapper) stops opening; its files go on until `exp`.
    expiresAt: new Date((iat + SANDBOX_TICKET_TTL_SECONDS) * 1000),
  };
}

/** Whether the ticket still opens its wrapper (a ticket `readSandboxTicket` returned is always
 * good for its files). */
export function sandboxWrapperOpen(ticket: SandboxTicket, now: Date): boolean {
  return (ticket.iat + SANDBOX_TICKET_TTL_SECONDS) * 1000 > now.getTime();
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
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp)
  );
}
