import { ensureAgentActivitySweep } from "#src/server/agents/agent-activity-sweep.server";
import { appNotificationPresence } from "#src/server/app-notifications/app-notification-presence.server";
import { setPresenceObserver } from "#src/server/app-notifications/presence-observer";
import { ensurePresenceSweep } from "#src/server/app-notifications/presence-sweep.server";

/**
 * The periodic sweeps the Centrifugo RPC composition starts, and the one place that connects the
 * presence observer to the status caches (which know only the `PresenceObserver` type, so they
 * load neither the database client nor the queue). Each sweep is idempotent per process and inert
 * until its feature is in use.
 */
export function registerBackgroundSweeps(): void {
  setPresenceObserver(appNotificationPresence);
  ensureAgentActivitySweep();
  ensurePresenceSweep();
}
