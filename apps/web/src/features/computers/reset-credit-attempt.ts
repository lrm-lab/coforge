import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

/**
 * The idempotency key of one attempt to use a reset credit on a Computer's runtime. A retry after
 * an unknown outcome or a thrown failure must send the same key, so the server can tell it from a
 * new attempt and never spends a second credit. The key lives in `sessionStorage` (it survives a
 * reload of the tab); a browser that refuses storage falls back to this module's memory.
 *
 * A key is the attempt of one account on one runtime, and only for a while: one abandoned would
 * otherwise be reused by a later, unrelated reset, which Codex answers `alreadyRedeemed` while
 * nothing resets. So the attempt is scoped by the account too, and expires.
 */
export const RESET_CREDIT_ATTEMPT_TTL_MS = 10 * 60_000;

type Attempt = { key: string; createdAt: number };

const memory = new Map<string, Attempt>();

const storageName = (computerId: string, provider: RuntimeProvider, account: string) =>
  `coforge:reset-credit:${JSON.stringify([computerId, provider, account])}`;

function readStored(name: string): Attempt | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(name) ?? "null");
    const attempt = value as Partial<Attempt> | null;
    return typeof attempt?.key === "string" && typeof attempt.createdAt === "number"
      ? { key: attempt.key, createdAt: attempt.createdAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The attempt's key: the one kept from an earlier try within the window, else a new one that is
 * kept from now on. `account` is the signed-in account as the popover names it ("" when it has
 * none).
 */
export function resetCreditAttemptKey(
  computerId: string,
  provider: RuntimeProvider,
  account: string,
  now: number = Date.now(),
): string {
  const name = storageName(computerId, provider, account);
  const existing = memory.get(name) ?? readStored(name);
  if (existing && now - existing.createdAt <= RESET_CREDIT_ATTEMPT_TTL_MS) {
    memory.set(name, existing);
    return existing.key;
  }
  const attempt = { key: crypto.randomUUID(), createdAt: now };
  memory.set(name, attempt);
  try {
    sessionStorage.setItem(name, JSON.stringify(attempt));
  } catch {
    // Memory holds it for this page's life.
  }
  return attempt.key;
}

/** Ends the attempt, once the server has given an answer that settles it. */
export function clearResetCreditAttempt(
  computerId: string,
  provider: RuntimeProvider,
  account: string,
): void {
  const name = storageName(computerId, provider, account);
  memory.delete(name);
  try {
    sessionStorage.removeItem(name);
  } catch {
    // Nothing stored to remove.
  }
}
