import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";

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
  s: string;
  iat: number;
  exp: number;
};

export type SandboxTicket = SandboxGrant & {
  n: string;
};

export type SandboxFileToken = SandboxGrant;

export const SANDBOX_TICKET_TTL_SECONDS = 2 * 60;

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
