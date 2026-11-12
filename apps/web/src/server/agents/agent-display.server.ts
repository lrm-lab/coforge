import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type {
  AgentActivity,
  AgentContextUsage,
  AgentServiceTier,
  AgentStatus,
} from "@lrm/coforge-sdk/internal";
import {
  credentialHoldReason,
  parseAgentDisplaySnapshot,
  type AgentDisplaySnapshot,
} from "@lrm/coforge-sdk/internal";
import { AGENT_STATUS_LEASE_MS } from "./agent-status.server";
import {
  END_HELD_STOP,
  OBSERVE_ACTIVITY,
  OBSERVE_STATUS,
  PUT_CONTEXT_USAGE,
  PUT_SERVICE_TIER,
  RECORD_STOP_REASON,
  SNAPSHOT_MANY,
  SWEEP_STALE,
} from "./agent-display-lua";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { activityKindForObservation, LIVENESS_ONLY_DETAIL_KINDS } from "./agent-activity-kind";

// 90s: 1.5x the daemon's 60s busy heartbeat (ACTIVITY_HEARTBEAT_MS), the same
// margin AGENT_STATUS_LEASE_MS keeps over AGENT_STATUS_REFRESH_MS. A silent
// turn stays visibly working/thinking as long as the heartbeat keeps landing.
const WORKING_LEASE_MS = 90_000;

// A single fleet-wide sorted set (not scoped under one Agent's key prefix,
// since AgentActivitySweep walks it across every Workspace/Computer/Agent):
// member `<workspaceId>:<computerId>:<agentId>`, score the busy activity's
// expiresAt. OBSERVE_ACTIVITY/OBSERVE_STATUS keep it in sync so the sweep
// never has to scan Agent state directly to find stale busy leases.
const LEASES_KEY = "coforge:agent-display:activity-leases";

export type Scope = Pick<AgentStatus, "workspaceId" | "computerId" | "agentId">;
type RedisPort = {
  eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArgs: Array<string | number>
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    ...args: Array<string | number>
  ): Promise<string[]>;
};

function leaseScopes(members: readonly string[]): Scope[] {
  return members.flatMap((member) => {
    const [workspaceId, computerId, agentId] = member.split(":");
    return workspaceId && computerId && agentId ? [{ workspaceId, computerId, agentId }] : [];
  });
}

/** One `SWEEP_STALE` outcome. `expired` is the only one carrying a fresh snapshot to push. */
export type ActivitySweepResult =
  | { outcome: "fresh" | "waiting" | "probe" }
  | { outcome: "expired"; snapshot: AgentDisplaySnapshot };

export interface AgentDisplay {
  observeStatus(status: AgentStatus): Promise<AgentDisplaySnapshot | undefined>;
  observeActivity(
    activity: AgentActivity & { computerId: string },
    fence: { daemonInstanceId: string; launchId: string },
  ): Promise<AgentDisplaySnapshot | undefined>;
  /** Sets the Agent's current context-window reading, guarded by the same
   * daemonInstanceId/clientSeq ordering rule `observeStatus` uses. */
  putContextUsage(message: AgentContextUsage): Promise<AgentDisplaySnapshot | undefined>;
  /** Sets the Agent's current service-tier reading (whether the launch got the Fast tier it
   * asked for), guarded by the same ordering rule `putContextUsage` uses. */
  putServiceTier(message: AgentServiceTier): Promise<AgentDisplaySnapshot | undefined>;
  /** Records why a settled control operation failed, for every managed path that never
   * produced a runtime_error Activity. Writes while the display sees the Agent as not
   * running; under a live lease the reason parks and surfaces when the display goes
   * offline. `detail` is the provider's own words when the settling path has them. */
  recordStopReason(
    scope: Scope,
    reason: string,
    detail?: string,
  ): Promise<AgentDisplaySnapshot | undefined>;
  /** Ends the reason a credential hold left on a live Agent (`errorReason`, the failure's) once
   * the Daemon reports the credential works again; undefined when nothing changed. */
  endHeldStop(scope: Scope, errorReason: string): Promise<AgentDisplaySnapshot | undefined>;
  snapshot(scope: Scope): Promise<AgentDisplaySnapshot>;
  /** Many snapshots in one round trip (a Workspace's Agent list); same value per scope as
   * `snapshot`, in the scopes' order. */
  snapshotMany(scopes: readonly Scope[]): Promise<AgentDisplaySnapshot[]>;
  /** The Workspace's Agents that are busy at `now`: the fleet-wide lease set's members whose
   * lease has not lapsed. Read-only; a lapsed lease the sweep has not dropped yet is not busy. */
  busyScopes(workspaceId: string, now: number): Promise<Scope[]>;
  /** Up to `limit` scopes whose busy lease score is at or before `now`, oldest first. */
  staleLeases(now: number, limit: number): Promise<Scope[]>;
  /** Advances one Agent's pending liveness probe. */
  sweepStale(
    scope: Scope,
    args: { probeId: string; timeoutMs: number },
  ): Promise<ActivitySweepResult>;
}

export class RedisAgentDisplay implements AgentDisplay {
  constructor(
    private readonly redis: RedisPort,
    private readonly clock: () => number = Date.now,
  ) {}

  async observeStatus(status: AgentStatus) {
    return this.execute(OBSERVE_STATUS, status, [
      status.status,
      status.daemonInstanceId,
      status.clientSeq,
      status.observedAtMs,
      AGENT_STATUS_LEASE_MS,
    ]);
  }

  async observeActivity(
    activity: AgentActivity & { computerId: string },
    fence: { daemonInstanceId: string; launchId: string },
  ) {
    const kind = activityKindForObservation(activity);
    if (!kind) return undefined;
    const isFiller =
      activity.isHeartbeat === true || LIVENESS_ONLY_DETAIL_KINDS.has(activity.detailKind);
    return this.execute(OBSERVE_ACTIVITY, activity, [
      kind,
      activity.detailKind,
      activity.launchId,
      fence.daemonInstanceId,
      fence.launchId,
      activity.clientSeq,
      activity.observedAtMs,
      activity.detail,
      JSON.stringify(activity.entries ?? []),
      WORKING_LEASE_MS,
      isFiller ? "1" : "0",
      activity.runtimeError?.errorReason ?? "",
      activity.runtimeError?.providerMessage ?? "",
      credentialHoldReason(activity.runtimeError) ? "1" : "0",
    ]);
  }

  async putContextUsage(message: AgentContextUsage) {
    return this.execute(PUT_CONTEXT_USAGE, message, [
      message.launchId,
      message.daemonInstanceId,
      message.clientSeq,
      message.observedAtMs,
      message.usedTokens,
      message.windowTokens,
    ]);
  }

  async putServiceTier(message: AgentServiceTier) {
    return this.execute(PUT_SERVICE_TIER, message, [
      message.launchId,
      message.daemonInstanceId,
      message.clientSeq,
      message.observedAtMs,
      message.requested ? "1" : "0",
      message.observed,
    ]);
  }

  async recordStopReason(scope: Scope, reason: string, detail?: string) {
    return this.execute(RECORD_STOP_REASON, scope, [reason, detail ?? ""]);
  }

  async endHeldStop(scope: Scope, errorReason: string) {
    return this.execute(END_HELD_STOP, scope, [errorReason]);
  }

  async snapshot(scope: Scope) {
    const [first] = await this.snapshotMany([scope]);
    if (!first) throw new Error("Agent display snapshot transaction returned no result");
    return first;
  }

  async snapshotMany(scopes: readonly Scope[]): Promise<AgentDisplaySnapshot[]> {
    if (scopes.length === 0) return [];
    // Both keys per scope, in the same order the single-scope scripts declare them; the script reads
    // this scope's own pair, so its lazy projection and save land on the right Agent.
    const keys = scopes.flatMap((scope) => [this.stateKey(scope), this.revisionKey(scope)]);
    const result = await this.redis.eval(
      SNAPSHOT_MANY,
      keys.length,
      ...keys,
      this.clock(),
      ...scopes.flatMap((scope) => [scope.workspaceId, scope.computerId, scope.agentId]),
    );
    if (!Array.isArray(result) || result.length !== scopes.length)
      throw new Error("Agent display snapshot transaction returned no result");
    return result.map((entry) => this.parseSnapshot(entry));
  }

  async busyScopes(workspaceId: string, now: number): Promise<Scope[]> {
    // `(now`: a lease expiring at `now` has lapsed (the scripts' `now >= expiresAt`).
    const members = await this.redis.zrangebyscore(LEASES_KEY, `(${now}`, "+inf");
    return leaseScopes(members).filter((scope) => scope.workspaceId === workspaceId);
  }

  async staleLeases(now: number, limit: number): Promise<Scope[]> {
    return leaseScopes(await this.redis.zrangebyscore(LEASES_KEY, "-inf", now, "LIMIT", 0, limit));
  }

  async sweepStale(
    scope: Scope,
    args: { probeId: string; timeoutMs: number },
  ): Promise<ActivitySweepResult> {
    const result = await this.redis.eval(
      SWEEP_STALE,
      3,
      this.stateKey(scope),
      this.revisionKey(scope),
      LEASES_KEY,
      this.clock(),
      scope.workspaceId,
      scope.computerId,
      scope.agentId,
      args.probeId,
      args.timeoutMs,
    );
    if (typeof result !== "string")
      throw new Error("Agent activity sweep transaction returned no result");
    const parsed = JSON.parse(result) as {
      outcome: ActivitySweepResult["outcome"];
      snapshot?: Record<string, unknown>;
    };
    if (parsed.outcome !== "expired") return { outcome: parsed.outcome };
    if (!parsed.snapshot) throw new Error("expired Agent activity sweep is missing its snapshot");
    const snapshot = parsed.snapshot;
    snapshot.revision = Number(snapshot.revision);
    snapshot.entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    return { outcome: "expired", snapshot: parseAgentDisplaySnapshot(snapshot) };
  }

  private parseSnapshot(entry: unknown): AgentDisplaySnapshot {
    if (typeof entry !== "string")
      throw new Error("Agent display snapshot transaction returned no result");
    const snapshot = JSON.parse(entry) as Record<string, unknown>;
    snapshot.revision = Number(snapshot.revision);
    snapshot.entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    return parseAgentDisplaySnapshot(snapshot);
  }

  private async execute(script: string, scope: Scope, args: Array<string | number>) {
    const result = await this.redis.eval(
      script,
      3,
      this.stateKey(scope),
      this.revisionKey(scope),
      LEASES_KEY,
      this.clock(),
      scope.workspaceId,
      scope.computerId,
      scope.agentId,
      ...args,
    );
    if (typeof result !== "string") return undefined;
    const snapshot = JSON.parse(result) as Record<string, unknown>;
    snapshot.revision = Number(snapshot.revision);
    snapshot.entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    return parseAgentDisplaySnapshot(snapshot);
  }

  private stateKey(scope: Scope) {
    return `${this.keyPrefix(scope)}:state`;
  }

  private revisionKey(scope: Scope) {
    return `${this.keyPrefix(scope)}:revision`;
  }

  private keyPrefix(scope: Scope) {
    return workspaceRedisKey({ ...scope, name: "display", version: "v1" });
  }
}

let singleton: RedisAgentDisplay | undefined;

export function getAgentDisplay(): AgentDisplay {
  const redisUrl = redisUrlFor("Agent display");
  singleton ??= new RedisAgentDisplay(openRedisClient(redisUrl));
  return singleton;
}
