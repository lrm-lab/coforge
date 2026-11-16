import type { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import type { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import type {
  InboxResponse,
  LocalInboxRequest,
  ReminderScope,
  ReminderSync,
} from "@lrm/coforge-sdk/internal";
import { diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type RuntimeAppInboxSyncPorts = {
  transport: () => DaemonConnectionClient;
  appConfigs: AgentAppConfigSync;
  reminders: ReminderScheduler;
  inboxCoordinator: AgentInboxCoordinator;
  env(): Omit<ReminderScope, "agentId">;
  readyRunningAgentIds(): string[];
  launchingAgentIds: Iterable<string>;
  /** Aborted when the daemon is stopping: an ask in flight stops asking, retrying and logging. */
  signal?: AbortSignal;
};

/** A new connection: asks again for every running Agent's App config. */
export function resyncAppConfigs(ports: RuntimeAppInboxSyncPorts): void {
  ports.appConfigs.connected();
  // A launch in progress asked on the old connection, whose answer is now dropped.
  for (const agentId of new Set([...ports.readyRunningAgentIds(), ...ports.launchingAgentIds]))
    requestAppConfigSnapshot(ports, agentId);
}

/** Asks once per connection for the Agent's App config; the cloud resends on the next one. */
export function requestAppConfigSnapshot(ports: RuntimeAppInboxSyncPorts, agentId: string): void {
  if (!ports.transport().requestAppConfigSnapshot) return;
  void ports.appConfigs.request(agentId).catch((error: unknown) =>
    logger.warn("Asking for an Agent's App config failed; the next connection asks again", {
      event: "agent_app_config:snapshot_failed",
      agent_id: agentId,
      error_code: diagnosticErrorName(error),
    }),
  );
}

/** What asked for the snapshot, so a line that never got one names its trigger. */
export type ReminderSnapshotReason =
  | "connection"
  | "agent_start"
  | "agent_context"
  | "unsynchronised_upsert";

/** How asking for an Agent's reminders ended. Only a landed snapshot ends it well; the rest say why
 * nothing asks again here. */
export type ReminderSnapshotOutcome =
  /** The snapshot arrived and was applied. */
  | "applied"
  /** This connection has no such method; the next connection asks again. */
  | "unavailable"
  /** The connection this ask belonged to is gone; its replacement asks on its own. */
  | "replaced"
  /** The daemon is stopping: no more asks, retries or lines. */
  | "stopped";

/** The retry schedule: one second, doubling to a five minute cap, and five minutes from then on. */
const SNAPSHOT_RETRY_CAP_MS = 300_000;
export function snapshotRetryDelayMs(failures: number): number {
  return Math.min(1_000 * 2 ** failures, SNAPSHOT_RETRY_CAP_MS);
}

/** One warning after the first failure, then at most one an hour: an outage stays in the log
 * without a line per attempt. */
const SNAPSHOT_WARN_EVERY_MS = 60 * 60_000;

/** Waits `ms`, and gives up as soon as `signal` aborts; true when the delay ran out. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (waited: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(waited);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** The connection an ask belongs to. `generation` is the one the ask started in, `current()` reads
 * the live one, and `signal` aborts when a newer connection replaces it, so a replaced loop ends at
 * once instead of waiting out its backoff. */
export type ReminderSnapshotGeneration = {
  generation: number;
  current(): number;
  signal: AbortSignal;
};

/** Asks for the Agent's reminders. Both ways this can end without a snapshot — the connection has
 * no such method, or the ask fails — used to be silent, and a Daemon whose reminders never arrived
 * looked exactly like a Daemon with none (2026-11-16: three days of an Agent's reminders never
 * firing, no line anywhere). A failed ask is therefore retried until it lands, until the connection
 * it belongs to is replaced, or until the daemon stops; only a stop bounds the wait. */
export async function requestReminderSnapshot(
  ports: RuntimeAppInboxSyncPorts,
  agentId: string,
  options: {
    reason?: ReminderSnapshotReason;
    /** The connection this ask belongs to. A newer one replaces it: this loop then ends without
     * another ask, another retry or another line. Without one the loop only ends by success or
     * stop, so every caller that can see a reconnect must pass it. */
    generation?: ReminderSnapshotGeneration;
    /** The retry schedule, for tests that cannot wait a minute; its last delay repeats. */
    retryDelaysMs?: readonly number[];
    /** The clock the hourly warning is measured on, for tests. */
    now?: () => number;
    /** Overrides the signal the ports carry. */
    signal?: AbortSignal;
  } = {},
): Promise<ReminderSnapshotOutcome> {
  const signal = options.signal ?? ports.signal;
  const generation = options.generation;
  const now = options.now ?? Date.now;
  const transport = ports.transport();
  const replaced = () => generation !== undefined && generation.current() !== generation.generation;
  /** Why this loop must not ask, retry or log any more, when it must not. */
  const ended = (): ReminderSnapshotOutcome | undefined =>
    signal?.aborted ? "stopped" : replaced() ? "replaced" : undefined;
  /** Either ending wakes the wait between attempts: a replaced loop holds no timer either. */
  const cancelled =
    signal && generation
      ? AbortSignal.any([signal, generation.signal])
      : (signal ?? generation?.signal);
  const early = ended();
  if (early) return early;
  if (!transport.requestSnapshot) {
    logger.warn("This connection cannot ask for an Agent's reminders", {
      event: "reminder_snapshot:unavailable",
      agent_id: agentId,
      reason: options.reason,
      outcome: "skipped",
    });
    return "unavailable";
  }
  const started = now();
  let warnedAt: number | undefined;
  for (let attempts = 1; ; attempts++) {
    const before = ended();
    if (before) return before;
    try {
      const sync: ReminderSync = await transport.requestSnapshot({ ...ports.env(), agentId });
      await ports.reminders.apply(sync);
      const done = ended();
      if (done) return done;
      if (attempts > 1)
        logger.info("Asking for an Agent's reminders succeeded at last", {
          event: "reminder_snapshot:recovered",
          agent_id: agentId,
          reason: options.reason,
          attempts,
          elapsed_ms: now() - started,
        });
      return "applied";
    } catch (error) {
      // A replaced connection or a stopping daemon says nothing here: the ask that belongs to the
      // live connection says what it finds there.
      const failed = ended();
      if (failed) return failed;
      const at = now();
      if (warnedAt === undefined || at - warnedAt >= SNAPSHOT_WARN_EVERY_MS) {
        warnedAt = at;
        logger.warn("Asking for an Agent's reminders failed; the retry continues", {
          event: "reminder_snapshot:failed",
          agent_id: agentId,
          reason: options.reason,
          attempts,
          error_code: diagnosticErrorName(error),
        });
      }
      const delays = options.retryDelaysMs;
      const delay = delays
        ? delays[Math.min(attempts - 1, delays.length - 1)]!
        : snapshotRetryDelayMs(attempts - 1);
      if (!(await pause(delay, cancelled))) return ended() ?? "replaced";
    }
  }
}

export function inbox(
  ports: RuntimeAppInboxSyncPorts,
  context: string,
  request: LocalInboxRequest,
): Promise<InboxResponse> {
  return ports.inboxCoordinator.inbox(context, request);
}

export function drainAppInboxNotices(
  ports: RuntimeAppInboxSyncPorts,
  agentId: string,
): Promise<void> {
  return ports.inboxCoordinator.drainAppInboxNotices(agentId);
}
