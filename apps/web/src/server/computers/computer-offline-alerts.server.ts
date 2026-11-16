import type { PrismaClient } from "#src/generated/prisma/client";
import { getDatabaseClient } from "#src/server/db/client.server";
import { isFeatureDefined } from "#src/server/feature-flags/feature-flags.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { errorType } from "#src/server/errors/error-type.server";
import { REDIS_NOW_MS_LUA } from "#src/server/app-notifications/presence-expiry.server";
import type { PresenceObserver } from "#src/server/app-notifications/presence-observer";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { createWebPushNotifications } from "#src/server/notifications/web-push-composition.server";

/** The flag that turns Computer offline alerts on; undefined in production until enabled. */
export function computerOfflineAlertsPossible(): boolean {
  return isFeatureDefined("computer-offline-alerts");
}

export const COMPUTER_OFFLINE_ALERT_AFTER_MS = 15 * 60_000;
const ALERT_SWEEP_INTERVAL_MS = 60_000;
const ALERT_SWEEP_LOCK_TTL_MS = 55_000;
const ALERT_SWEEP_LOCK_KEY = "coforge:computer-offline:alert-sweep:lock";
const EPISODE_KEY_PREFIX = "coforge:computer-offline:v1:";
const EPISODE_INDEX_KEY = `${EPISODE_KEY_PREFIX}index`;
const ALERT_CLAIM_PREFIX = "coforge:computer-offline-alert:v1:";
const EPISODE_BATCH_LIMIT = 200;

/**
 * The episode marker and the index that names it move in one script, so a report can never leave
 * one without the other. An offline report files the Computer under the first report's timestamp
 * (`SET NX` keeps it; a second binding's report changes nothing) and an online report clears both.
 * KEYS[1] is the episode key, KEYS[2] the index; ARGV is computerId, observedAtMs, "online"|"offline".
 */
const WRITE_COMPUTER_OFFLINE_EPISODE = `
if ARGV[3] == "offline" then
  redis.call("SADD", KEYS[2], ARGV[1])
  return redis.call("SET", KEYS[1], ARGV[2], "NX")
end
redis.call("DEL", KEYS[1])
return redis.call("SREM", KEYS[2], ARGV[1])
`;

/**
 * Ends an episode only while it is still the one the caller read: the marker goes when it still
 * holds the expected value ("" when absent), and the index member goes only once no marker is
 * left — so a flap that started a newer episode between the caller's read and this script keeps
 * both its marker and its index entry. KEYS[1] is the episode key, KEYS[2] the index; ARGV is the
 * expected marker value and the computerId.
 */
const END_COMPUTER_OFFLINE_EPISODE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
end
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("SREM", KEYS[2], ARGV[2])
end
return 1
`;

export interface ComputerOfflineRedis {
  eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  del(...keys: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  send(command: string, args: string[]): Promise<unknown>;
}

function episodeKey(computerId: string) {
  return `${EPISODE_KEY_PREFIX}${computerId}`;
}

function alertClaimKey(computerId: string, offlineAtMs: number) {
  return `${ALERT_CLAIM_PREFIX}${computerId}:${offlineAtMs}`;
}

/**
 * One offline episode per Computer, however many Workspace bindings report it: the status
 * caches' `computerPresence` reports arrive once per (Workspace, Computer) status key, so the
 * first offline report of an episode wins the marker and the first online report ends it. A
 * recovery that is partial across bindings can end the episode early; the next offline report
 * starts a fresh one. The marker can also outlive its episode (a flag-off window or a failed
 * write); `ComputerOfflineAlertSweep` reconciles it against the live status keys before alerting.
 */
export class ComputerOfflineAlerts implements PresenceObserver {
  constructor(
    private readonly deps: {
      possible: () => boolean;
      redis: () => ComputerOfflineRedis;
    },
  ) {}

  enabled(): boolean {
    return this.deps.possible();
  }

  agentStatus(): void {}

  computerPresence(change: Parameters<PresenceObserver["computerPresence"]>[0]): void {
    if (!this.deps.possible()) return;
    const { computerId, to, observedAtMs } = change;
    // Deferred one microtask so a Redis client that cannot open (a missing URL) rejects into the
    // catch instead of throwing into the status write that reported the transition.
    void Promise.resolve()
      .then(() =>
        this.deps
          .redis()
          .eval(
            WRITE_COMPUTER_OFFLINE_EPISODE,
            2,
            episodeKey(computerId),
            EPISODE_INDEX_KEY,
            computerId,
            String(observedAtMs),
            to,
          ),
      )
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "computer_offline_episode.write_failed",
            error_type: errorType(error),
          }),
        );
      });
  }
}

export type ComputerOfflineAlertTarget =
  | { status: "gone" }
  | { status: "no_workspace" }
  | {
      status: "ready";
      workspaceId: string;
      ownerId: string;
      computerName: string;
      workspaceSlug: string;
      username: string;
    };

/** The workspace the notice lands in: the earliest binding whose Workspace still has the
 * Computer's owner as a member. */
export async function resolveComputerOfflineAlertTarget(
  db: PrismaClient,
  computerId: string,
): Promise<ComputerOfflineAlertTarget> {
  const computer = await db.computer.findUnique({
    where: { id: computerId },
    select: { ownerId: true, displayName: true, name: true, deletedAt: true },
  });
  if (!computer || computer.deletedAt) return { status: "gone" };
  const bindings = await db.workspaceComputer.findMany({
    where: { computerId },
    orderBy: [{ createdAt: "asc" }, { workspaceId: "asc" }],
    select: { workspaceId: true },
  });
  if (bindings.length === 0) return { status: "no_workspace" };
  const memberships = await db.workspaceMembership.findMany({
    where: {
      userId: computer.ownerId,
      workspaceId: { in: bindings.map((binding) => binding.workspaceId) },
    },
    select: { workspaceId: true },
  });
  const memberWorkspaces = new Set(memberships.map((membership) => membership.workspaceId));
  const binding = bindings.find((candidate) => memberWorkspaces.has(candidate.workspaceId));
  if (!binding) return { status: "no_workspace" };
  const [workspace, user] = await Promise.all([
    db.workspace.findUnique({ where: { id: binding.workspaceId }, select: { slug: true } }),
    db.user.findUnique({ where: { id: computer.ownerId }, select: { username: true } }),
  ]);
  if (!workspace || !user) return { status: "no_workspace" };
  return {
    status: "ready",
    workspaceId: binding.workspaceId,
    ownerId: computer.ownerId,
    computerName: computer.displayName || computer.name || "Computer",
    workspaceSlug: workspace.slug,
    username: user.username,
  };
}

export interface ComputerOfflineAlertNotice {
  workspaceId: string;
  ownerId: string;
  computerName: string;
  computerId: string;
  workspaceSlug: string;
  username: string;
  offlineAtMs: number;
}

/** One assistant DM to the Computer's owner, through their own Workspace assistant — the same
 * shape as the weekly-report invitation (`records/weekly-report-notification.server.ts`). */
export async function notifyComputerOfflineAlert(
  db: PrismaClient,
  input: ComputerOfflineAlertNotice,
): Promise<void> {
  const assistant = await new WorkspaceAssistants(db).ensure(input.workspaceId, input.ownerId);
  const idempotencyKey = `computer-offline:${input.computerId}:${input.offlineAtMs}:${input.ownerId}`;
  const idempotency = getMessageRequestIdempotency();
  // A send whose Message committed but whose publication failed is retried by the sweep; the
  // stored record means the notice already landed, so the retry must not notify or publish again.
  if (
    (
      await idempotency.find({
        workspaceId: input.workspaceId,
        senderKind: "agent",
        senderId: assistant.agentId,
        idempotencyKey,
      })
    )?.state === "completed"
  )
    return;
  const api = createCentrifugoServerApi();
  const messages = new SendDirectMessage(
    new PrismaDirectConversationRepository(db),
    idempotency,
    api,
    new CentrifugoConversationRealtime(api),
    await createWebPushNotifications(db),
  );
  const url = `/w/${input.workspaceSlug}/computer/${input.computerId}`;
  await messages.executeFromAgent({
    workspaceId: input.workspaceId,
    agentId: assistant.agentId,
    target: `@${input.username}~human`,
    idempotencyKey,
    body: `「${input.computerName}」已离线 ${COMPUTER_OFFLINE_ALERT_AFTER_MS / 60_000} 分钟，上面的 Agent 都停了。\n\n[查看这台 Computer](${url})`,
  });
}

/**
 * The alert half of the offline episode: every minute one web instance claims the index of
 * Computers whose offline episode is at least `COMPUTER_OFFLINE_ALERT_AFTER_MS` old, checks the
 * live status keys still agree the Computer is down (a marker can outlive its episode), resolves
 * where the owner can be told (the earliest binding whose Workspace still has them), and sends
 * one assistant DM. A failed send releases its claim so the next tick retries; an episode whose
 * owner has no eligible Workspace, whose Computer is gone or already back online consumes itself
 * without a message. Inert while `possible()` is false; like `PresenceSweep` it never rejects.
 */
export class ComputerOfflineAlertSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly redis: () => ComputerOfflineRedis;
  private readonly lock: { acquire(instanceId: string): Promise<boolean> };
  private readonly instanceId: string;
  private readonly possible: () => boolean;
  private readonly resolve: (computerId: string) => Promise<ComputerOfflineAlertTarget>;
  private readonly stillOnline: (computerId: string) => Promise<boolean>;
  private readonly notify: (input: ComputerOfflineAlertNotice) => Promise<void>;
  private readonly nowMs: () => Promise<number>;

  constructor(options: {
    redis: () => ComputerOfflineRedis;
    lock: { acquire(instanceId: string): Promise<boolean> };
    possible: () => boolean;
    resolve?: (computerId: string) => Promise<ComputerOfflineAlertTarget>;
    stillOnline?: (computerId: string) => Promise<boolean>;
    notify?: (input: ComputerOfflineAlertNotice) => Promise<void>;
    db?: () => PrismaClient | undefined;
    instanceId?: string;
    now?: () => number;
  }) {
    this.redis = options.redis;
    this.lock = options.lock;
    this.possible = options.possible;
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    const db = options.db ?? getDatabaseClient;
    const redis = options.redis;
    const now = options.now;
    this.resolve =
      options.resolve ??
      (async (computerId) => {
        const client = db();
        if (!client) throw new Error("database client is unavailable");
        return resolveComputerOfflineAlertTarget(client, computerId);
      });
    // Any binding's status key saying "online" means the Computer is back: the episode marker is
    // stale (a flag-off window or a failed delete) and the episode ends without an alert.
    this.stillOnline =
      options.stillOnline ??
      (async (computerId) => {
        const client = db();
        if (!client) return false;
        const bindings = await client.workspaceComputer.findMany({
          where: { computerId },
          select: { workspaceId: true },
        });
        if (bindings.length === 0) return false;
        const statuses = await redis().mget(
          ...bindings.map((binding) =>
            workspaceRedisKey({
              workspaceId: binding.workspaceId,
              computerId,
              name: "status",
              version: "v1",
            }),
          ),
        );
        return statuses.some((status) => status === "online");
      });
    this.notify =
      options.notify ??
      (async (input) => {
        const client = db();
        if (!client) throw new Error("database client is unavailable");
        await notifyComputerOfflineAlert(client, input);
      });
    // The episode timestamps are Redis's clock (the status write's `now_ms`), so the threshold
    // reads it too, once per tick like `PresenceSweep`'s scores; `now` is the test seam.
    this.nowMs = now
      ? async () => now()
      : async () => Number(await redis().eval(`${REDIS_NOW_MS_LUA}return now_ms`, 0));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), ALERT_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.possible()) return;
    this.ticking = true;
    try {
      if (!(await this.lock.acquire(this.instanceId))) return;
      const nowMs = await this.nowMs();
      const members = await this.redis().smembers(EPISODE_INDEX_KEY);
      for (const computerId of members.slice(0, EPISODE_BATCH_LIMIT))
        await this.sweepOne(computerId, nowMs);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "computer_offline_alert_sweep.tick_failed",
          error_type: errorType(error),
        }),
      );
    } finally {
      this.ticking = false;
    }
  }

  private async endEpisode(
    computerId: string,
    marker: string | null,
    claimKey?: string,
  ): Promise<void> {
    await this.redis().eval(
      END_COMPUTER_OFFLINE_EPISODE,
      2,
      episodeKey(computerId),
      EPISODE_INDEX_KEY,
      marker ?? "",
      computerId,
    );
    if (claimKey) await this.redis().del(claimKey);
  }

  private async sweepOne(computerId: string, nowMs: number): Promise<void> {
    const marker = await this.redis().get(episodeKey(computerId));
    if (marker === null) {
      await this.endEpisode(computerId, null);
      return;
    }
    const offlineAtMs = Number(marker);
    if (!Number.isFinite(offlineAtMs)) {
      await this.endEpisode(computerId, marker);
      return;
    }
    if (nowMs - offlineAtMs < COMPUTER_OFFLINE_ALERT_AFTER_MS) return;
    const claimKey = alertClaimKey(computerId, offlineAtMs);
    if ((await this.redis().send("SET", [claimKey, "1", "NX"])) === null) return;
    try {
      if (await this.stillOnline(computerId)) {
        await this.endEpisode(computerId, marker, claimKey);
        return;
      }
      const target = await this.resolve(computerId);
      if (target.status !== "ready") {
        await this.endEpisode(computerId, marker, claimKey);
        return;
      }
      await this.notify({
        workspaceId: target.workspaceId,
        ownerId: target.ownerId,
        computerName: target.computerName,
        computerId,
        workspaceSlug: target.workspaceSlug,
        username: target.username,
        offlineAtMs,
      });
      // The notice is out; while the Computer stays down nothing else is owed, so the episode
      // keys go too (a flap that already restarted it keeps its own marker and index entry).
      await this.endEpisode(computerId, marker, claimKey);
    } catch (error) {
      await this.redis()
        .del(claimKey)
        .catch(() => {});
      console.error(
        JSON.stringify({
          event: "computer_offline_alert.send_failed",
          error_type: errorType(error),
        }),
      );
    }
  }
}

let redisClient: ComputerOfflineRedis | undefined;

/** Opened at the first write or tick that runs, so a deployment without the flag opens no
 * connection; one that turns it on with a flag file reload gets it then. */
function offlineAlertsRedis(): ComputerOfflineRedis {
  if (redisClient) return redisClient;
  const client = openRedisClient(redisUrlFor("the computer offline alerts"));
  redisClient = {
    eval: (script, keys, ...args) => client.eval(script, keys, ...args),
    get: (key) => client.get(key),
    mget: (...keys) => client.mget(...keys),
    del: (...keys) => client.del(...keys),
    smembers: (key) => client.smembers(key),
    send: (command, args) => client.send(command, args),
  };
  return redisClient;
}

let alertsObserver: ComputerOfflineAlerts | undefined;

/** The presence observer the status caches report Computer transitions to for offline
 * episodes; shares the sweep's Redis client. */
export function computerOfflineAlerts(): ComputerOfflineAlerts {
  return (alertsObserver ??= new ComputerOfflineAlerts({
    possible: computerOfflineAlertsPossible,
    redis: offlineAlertsRedis,
  }));
}

let singleton: ComputerOfflineAlertSweep | undefined;
let stopRegistered = false;

/** Idempotent per process; called by `registerBackgroundSweeps`. Inert while the
 * `computer-offline-alerts` flag is undefined, opening no Redis connection until a tick runs. */
export function ensureComputerOfflineAlertSweep(): ComputerOfflineAlertSweep {
  if (!singleton) {
    singleton = new ComputerOfflineAlertSweep({
      redis: offlineAlertsRedis,
      lock: {
        acquire: async (instanceId) =>
          (await offlineAlertsRedis().send("SET", [
            ALERT_SWEEP_LOCK_KEY,
            instanceId,
            "NX",
            "PX",
            String(ALERT_SWEEP_LOCK_TTL_MS),
          ])) !== null,
      },
      possible: computerOfflineAlertsPossible,
    });
  }
  if (!stopRegistered) {
    stopRegistered = true;
    const sweep = singleton;
    onServerShutdown(() => sweep.stop());
  }
  singleton.start();
  return singleton;
}
