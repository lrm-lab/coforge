import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { sanitizeUpgradeErrorText } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { sameImageLayer } from "#src/features/computers/cloud-image-update";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import type { ComputerUpgradeStatus } from "#src/features/computers/computer.schemas";
import { getCloudImageInventory } from "#src/server/hosts/cloud-image-inventory.server";
import {
  BEGIN_UPGRADE,
  COMMIT_READY,
  REPLACE,
  REPLACE_IF_ACCEPTED,
  STORE_NEWER_IDENTITY,
} from "./computer-upgrade-lua";
import {
  parseComputerUpgradeIdentity,
  parseComputerUpgradeRecord,
  reportedRequestId,
  type ComputerUpgradeIdentity,
  type ComputerUpgradeRecord,
  type ComputerUpgradeScope,
  type ReportedComputerUpgradeResult,
} from "./computer-upgrade-record";

/** An upgrade request's deadline, long enough to poll a Computer to completion, and how long a
 * settled record survives. */
const REQUEST_TTL = 10 * 60;
/** Keeps a new request's keys past its deadline: a read there must find the record to report the
 * timeout, not that the request is unknown. */
const REQUEST_GRACE = 60;
/** How long a new request's record and the Computer's latest pointer live. */
const REQUEST_KEY_TTL = String(REQUEST_TTL + REQUEST_GRACE);

export class RedisComputerUpgradeStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      mget(...keys: string[]): Promise<Array<string | null>>;
      set(...args: string[]): Promise<unknown>;
      send(command: string, args: string[]): Promise<unknown>;
    },
    private readonly now = Date.now,
    private readonly runningImage?: (computerId: string) => Promise<string | undefined>,
  ) {}
  async identity(scope: ComputerUpgradeScope): Promise<ComputerUpgradeIdentity | undefined> {
    return parseComputerUpgradeIdentity(await this.redis.get(this.identityKey(scope)));
  }
  async begin(
    scope: ComputerUpgradeScope,
    requestId: string,
    expectedVersion: string,
    options?: { completeOnIdentity?: boolean; expectedImageId?: string },
  ) {
    const existingRaw = await this.redis.get(this.requestKey(scope, requestId));
    const existing = existingRaw ? parseComputerUpgradeRecord(existingRaw) : undefined;
    if (existing) return { status: this.public(existing), created: false };
    const current = await this.identity(scope);
    if (!current) throw new AppError("COMPUTER_IDENTITY_UNKNOWN");
    const record: ComputerUpgradeRecord = {
      requestId,
      status: "accepted",
      expectedVersion,
      expiresAt: new Date(this.now() + REQUEST_TTL * 1000).toISOString(),
      previousWorkerInstanceId: current.workerInstanceId,
      ...(options?.completeOnIdentity ? { completeOnIdentity: true as const } : {}),
      ...(options?.expectedImageId ? { expectedImageId: options.expectedImageId } : {}),
    };
    const key = this.requestKey(scope, requestId);
    const reply = await this.redis.send("EVAL", [
      BEGIN_UPGRADE,
      "3",
      key,
      this.latestKey(scope),
      this.inflightKey(scope),
      JSON.stringify(record),
      REQUEST_KEY_TTL,
      `${this.scope(scope)}:request:`,
      requestId,
    ]);
    const [code, payload] = Array.isArray(reply) ? reply : [];
    if (code === 1) return { status: this.public(record), created: true };
    // Codes 0 (another request is in flight) and 2 (this requestId already had a record) both
    // carry the stored record to answer with; nothing new was published for it.
    const stored = typeof payload === "string" ? parseComputerUpgradeRecord(payload) : undefined;
    if (stored) return { status: this.public(stored), created: false };
    throw new Error("upgrade request could not be registered");
  }
  /**
   * The upgrade most recently begun on each Computer, while its record lives, in the scopes'
   * order: two round trips for the list page however many Computers it shows.
   */
  async latestMany(
    scopes: readonly ComputerUpgradeScope[],
  ): Promise<Array<ComputerUpgradeStatus | undefined>> {
    if (scopes.length === 0) return [];
    const requestIds = await this.redis.mget(...scopes.map((scope) => this.latestKey(scope)));
    const requestKeys = scopes.flatMap((scope, index) => {
      const requestId = requestIds[index];
      return requestId ? [this.requestKey(scope, requestId)] : [];
    });
    const raws = requestKeys.length ? await this.redis.mget(...requestKeys) : [];
    // The second read holds a record only for the Computers that had a pointer, in their order.
    let next = 0;
    return Promise.all(
      scopes.map((scope, index) => {
        const requestId = requestIds[index];
        return requestId ? this.statusOf(scope, requestId, raws[next++] ?? null) : undefined;
      }),
    );
  }
  async publicationFailed(scope: ComputerUpgradeScope, requestId: string) {
    const key = this.requestKey(scope, requestId);
    const raw = await this.redis.get(key);
    const current = raw ? parseComputerUpgradeRecord(raw) : undefined;
    await this.replaceAccepted(
      key,
      this.withUpgradeTarget(current, {
        requestId,
        status: "failed",
        reason: "publication",
      }),
    );
  }
  /**
   * Accepts the Daemon's terminal report for one operation. A reported failure is authoritative:
   * only the Computer can observe it, and without it a local failure is indistinguishable from a
   * Computer that has not reconnected yet. A reported success is never sufficient on its own -
   * the Computer must still come back with an identity that proves the new version is running -
   * so it only completes a request whose identity evidence already agrees.
   */
  async reported(
    scope: ComputerUpgradeScope,
    result: ReportedComputerUpgradeResult,
  ): Promise<void> {
    const id = reportedRequestId(result);
    const key = this.requestKey(scope, id);
    const raw = await this.redis.get(key);
    const current = raw ? parseComputerUpgradeRecord(raw) : undefined;
    // A settled request is never reopened by a late or contradictory report.
    if (!raw || current?.status !== "accepted") return;
    if (result.status === "failed") {
      await this.replaceAccepted(
        key,
        this.withUpgradeTarget(current, {
          requestId: result.requestId,
          status: "failed",
          reason: "reported",
          ...(result.error ? { error: sanitizeUpgradeErrorText(result.error) } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        }),
      );
      return;
    }
    if (result.version && result.version !== current.expectedVersion) return;
    const identity = await this.identity(scope);
    if (
      !identity ||
      current.previousWorkerInstanceId === identity.workerInstanceId ||
      current.expectedVersion !== identity.computerVersion ||
      identity.computerVersion !== identity.daemonVersion
    )
      return;
    await this.commitReady(scope, key, raw, identity, {
      requestId: result.requestId,
      status: "completed",
      expectedVersion: current.expectedVersion,
      ...identity,
      completedAt: new Date(this.now()).toISOString(),
    });
  }
  async status(
    scope: ComputerUpgradeScope,
    requestId: string,
  ): Promise<ComputerUpgradeStatus | undefined> {
    return this.statusOf(scope, requestId, await this.redis.get(this.requestKey(scope, requestId)));
  }
  /** A stored record as it reads now: past its deadline it has timed out, and a cloud image
   * replace completes once the Computer's identity shows the new image. */
  private async statusOf(
    scope: ComputerUpgradeScope,
    requestId: string,
    raw: string | null,
  ): Promise<ComputerUpgradeStatus | undefined> {
    if (!raw) return undefined;
    const current = parseComputerUpgradeRecord(raw);
    if (!current) return { requestId, status: "unknown", reason: "corrupt" };
    if (current.status === "accepted" && current.completeOnIdentity) {
      const completed = await this.completeFromIdentity(
        scope,
        this.requestKey(scope, requestId),
        raw,
        current,
      );
      if (completed) return this.public(completed);
    }
    if (current.status === "accepted" && Date.parse(current.expiresAt) <= this.now()) {
      const failed = this.withUpgradeTarget(current, {
        requestId,
        status: "failed",
        reason: "timeout",
      });
      if (await this.replace(this.requestKey(scope, requestId), failed)) return this.public(failed);
    }
    return this.public(current);
  }
  /**
   * Settles upgrade requests on the Computer's own evidence: every request it began that is
   * still accepted - the daemon's recovered ids unioned with the inflight set - completes once
   * the new identity proves the version, so a request whose terminal report was lost across
   * the upgrade restart cannot leave the page waiting out its deadline. A recovered request
   * the identity cannot prove fails closed as before; one the daemon never recovered stays
   * accepted - its report or a later proving ready still settles it. Cloud image and runtime
   * replaces (`completeOnIdentity`) are left to their own status-read completion.
   */
  async ready(
    scope: ComputerUpgradeScope,
    identity: ComputerUpgradeIdentity,
    recoveredIds: readonly string[],
  ) {
    const recovered = new Set(recoveredIds);
    const requests = new Map<string, string>();
    for (const id of recoveredIds) requests.set(id, this.requestKey(scope, id));
    for (const id of await this.inflightMembers(scope))
      requests.set(id, this.requestKey(scope, id));
    const settled: string[] = [];
    for (const [id, key] of requests) {
      const raw = await this.redis.get(key);
      const current = raw ? parseComputerUpgradeRecord(raw) : undefined;
      if (current?.status === "accepted" && current.completeOnIdentity) continue;
      if (!raw || current?.status !== "accepted") {
        settled.push(id);
        continue;
      }
      const proven =
        current.previousWorkerInstanceId !== identity.workerInstanceId &&
        current.expectedVersion === identity.computerVersion &&
        identity.computerVersion === identity.daemonVersion;
      if (proven) {
        if (
          await this.commitReady(scope, key, raw, identity, {
            requestId: current.requestId,
            status: "completed",
            expectedVersion: current.expectedVersion,
            ...identity,
            completedAt: new Date(this.now()).toISOString(),
          })
        )
          settled.push(id);
      } else if (recovered.has(id)) {
        if (
          await this.replace(
            key,
            this.withUpgradeTarget(current, {
              requestId: current.requestId,
              status: "failed",
              reason: "evidence",
            }),
          )
        )
          settled.push(id);
      }
    }
    if (settled.length > 0) await this.redis.send("SREM", [this.inflightKey(scope), ...settled]);
    await this.storeNewerIdentity(scope, identity);
  }
  /**
   * Transitional only: identity keys are durable now (no expiry) and only `ready` creates or
   * replaces one, so this can never fabricate an identity for a Computer that does not have one
   * on record. What it does do is clear a leftover 90s lease that a pre-durable-identity Web
   * deploy left on an already-connected Computer's identity key - re-submitting the stored value
   * through the same monotonic guard `ready` uses SETs it back without an expiry. Daemons do not
   * reconnect just because Web deployed, so without this call a Computer that stayed connected
   * across the deploy would keep the old lease until it happened to reconnect on its own. Safe to
   * remove once every Computer has re-reported `ready` at least once after this change ships.
   */
  async touchIdentity(scope: ComputerUpgradeScope): Promise<void> {
    const raw = await this.redis.get(this.identityKey(scope));
    if (!raw || !parseComputerUpgradeIdentity(raw)) return;
    await this.redis.send("EVAL", [STORE_NEWER_IDENTITY, "1", this.identityKey(scope), raw]);
  }
  private async completeFromIdentity(
    scope: ComputerUpgradeScope,
    key: string,
    raw: string,
    current: ComputerUpgradeRecord,
  ): Promise<ComputerUpgradeRecord | undefined> {
    if (current.status !== "accepted") return undefined;
    const requestId = current.requestId;
    const identity = await this.identity(scope);
    const runningImageId = current.expectedImageId
      ? await this.runningImage?.(scope.computerId)
      : undefined;
    const imageReplaced =
      Boolean(current.expectedImageId) &&
      sameImageLayer(current.expectedImageId ?? "", runningImageId ?? "");
    if (imageReplaced) {
      const record = this.withUpgradeTarget(current, {
        requestId,
        status: "completed",
        expectedVersion: current.expectedVersion,
        computerVersion: current.expectedVersion,
        daemonVersion: identity?.daemonVersion ?? current.expectedVersion,
        workerInstanceId:
          identity?.workerInstanceId ?? current.previousWorkerInstanceId ?? requestId,
        completedAt: new Date(this.now()).toISOString(),
      });
      if (await this.replace(key, record)) return record;
      return undefined;
    }
    if (
      !identity ||
      current.previousWorkerInstanceId === identity.workerInstanceId ||
      current.expectedVersion !== identity.computerVersion ||
      identity.computerVersion !== identity.daemonVersion
    )
      return undefined;
    const record: ComputerUpgradeRecord = {
      requestId,
      status: "completed",
      expectedVersion: current.expectedVersion,
      ...identity,
      completedAt: new Date(this.now()).toISOString(),
    };
    if (await this.commitReady(scope, key, raw, identity, record)) return record;
    return undefined;
  }
  private async storeNewerIdentity(scope: ComputerUpgradeScope, identity: ComputerUpgradeIdentity) {
    await this.redis.send("EVAL", [
      STORE_NEWER_IDENTITY,
      "1",
      this.identityKey(scope),
      JSON.stringify(identity),
    ]);
  }
  private async replace(key: string, record: ComputerUpgradeRecord) {
    const current = await this.redis.get(key);
    return current
      ? (await this.redis.send("EVAL", [
          REPLACE,
          "1",
          key,
          current,
          JSON.stringify(record),
          String(REQUEST_TTL),
        ])) === 1
      : false;
  }
  private async replaceAccepted(key: string, record: ComputerUpgradeRecord) {
    const current = await this.redis.get(key);
    if (!current || parseComputerUpgradeRecord(current)?.status !== "accepted") return false;
    return (
      (await this.redis.send("EVAL", [
        REPLACE_IF_ACCEPTED,
        "1",
        key,
        current,
        JSON.stringify(record),
        String(REQUEST_TTL),
      ])) === 1
    );
  }
  private async commitReady(
    scope: ComputerUpgradeScope,
    key: string,
    current: string,
    identity: ComputerUpgradeIdentity,
    record: ComputerUpgradeRecord,
  ) {
    return (
      (await this.redis.send("EVAL", [
        COMMIT_READY,
        "2",
        key,
        this.identityKey(scope),
        current,
        JSON.stringify(identity),
        JSON.stringify(record),
        String(REQUEST_TTL),
      ])) === 1
    );
  }
  /** Keeps the image-replace marker so a later public status still names the Image row. */
  private withUpgradeTarget(
    current: ComputerUpgradeRecord | undefined,
    next: ComputerUpgradeRecord,
  ): ComputerUpgradeRecord {
    return current?.expectedImageId ? { ...next, expectedImageId: current.expectedImageId } : next;
  }

  private public(stored: ComputerUpgradeRecord): ComputerUpgradeStatus {
    const {
      previousWorkerInstanceId: _previous,
      completeOnIdentity: _completeOnIdentity,
      expectedImageId,
      ...value
    } = stored;
    if (value.status === "unknown") return value;
    // Image replaces store the offered layer id; runtime upgrades (cloud or local) do not.
    return { ...value, target: expectedImageId ? "image" : "runtime" };
  }
  private scope(scope: ComputerUpgradeScope) {
    return workspaceRedisKey({
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
      name: "upgrade",
      version: "v1",
    });
  }
  private identityKey(scope: ComputerUpgradeScope) {
    return `${this.scope(scope)}:identity`;
  }
  private latestKey(scope: ComputerUpgradeScope) {
    return `${this.scope(scope)}:latest`;
  }
  private inflightKey(scope: ComputerUpgradeScope) {
    return `${this.scope(scope)}:inflight`;
  }
  /** Every request id begun on this Computer and not yet known settled; members are raw
   * requestIds, matching what `begin` SADDs. */
  private async inflightMembers(scope: ComputerUpgradeScope): Promise<string[]> {
    const members = await this.redis.send("SMEMBERS", [this.inflightKey(scope)]);
    return Array.isArray(members)
      ? members.filter((member): member is string => typeof member === "string")
      : [];
  }
  private requestKey(scope: ComputerUpgradeScope, requestId: string) {
    return `${this.scope(scope)}:request:${encodeURIComponent(requestId)}`;
  }
}

let singleton: RedisComputerUpgradeStore | undefined;
export function getComputerUpgradeStore() {
  const url = redisUrlFor("Computer upgrade status");
  singleton ??= new RedisComputerUpgradeStore(
    openRedisClient(url),
    Date.now,
    async (computerId) => {
      const snapshot = await getCloudImageInventory().snapshot();
      return snapshot?.computers.find((computer) => computer.computerId === computerId)?.imageId;
    },
  );
  return singleton;
}
