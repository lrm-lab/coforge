import { requireDatabaseClient } from "#src/server/db/client.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";

/**
 * The attach-session and retired-login sweep (task #417): expired, refused or consumed attach
 * sessions go, and a retired-login row goes once the token it names could not still be live —
 * a JWT's exp is at most an hour past its `retire-session`, so a row older than that is past
 * every token it ever covered.
 */
const SWEEP_INTERVAL_MS = 10 * 60_000;
const RETIRED_LOGIN_LIFE_MS = 60 * 60_000;

export async function sweepComputerAttach(now = new Date()): Promise<{
  sessions: number;
  retiredLogins: number;
}> {
  const db = requireDatabaseClient();
  const sessions = await db.computerAttachSession.deleteMany({
    where: {
      OR: [
        // An approved session that polled keeps its row until the token's own 10 min runs; one
        // that never polled has no token to protect and goes by its own expiry.
        {
          status: "approved",
          OR: [
            { attachTokenExpiresAt: { lt: now } },
            { attachTokenExpiresAt: null, expiresAt: { lt: now } },
          ],
        },
        { status: { not: "approved" }, expiresAt: { lt: now } },
        { status: "refused" },
        { status: "consumed" },
      ],
    },
  });
  const retiredLogins = await db.computerRetiredLogin.deleteMany({
    where: { retiredAt: { lt: new Date(now.getTime() - RETIRED_LOGIN_LIFE_MS) } },
  });
  return { sessions: sessions.count, retiredLogins: retiredLogins.count };
}

let sweep: ReturnType<typeof setInterval> | undefined;

/** Starts the ten-minute sweep once per process, idempotent like its neighbours. */
export function ensureComputerAttachSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => {
    sweepComputerAttach().catch(() => {});
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
  onServerShutdown(() => clearInterval(sweep));
}
