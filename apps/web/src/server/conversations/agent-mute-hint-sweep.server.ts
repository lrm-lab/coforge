import { requireDatabaseClient } from "#src/server/db/client.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { AgentMuteHints } from "./agent-mute-hint.server";

let started = false;

/** Hourly: a mute suggestion whose seven-day window passed without a mute is `ignored`. */
export function ensureAgentMuteHintSweep(): void {
  if (started) return;
  started = true;
  const timer = setInterval(
    () => {
      try {
        void new AgentMuteHints(requireDatabaseClient()).ignoreExpired().catch(() => undefined);
      } catch {
        // The database is not up yet; the next tick tries again.
      }
    },
    60 * 60 * 1000,
  );
  timer.unref();
  onServerShutdown(() => clearInterval(timer));
}
