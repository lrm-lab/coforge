import type {
  RuntimeAuthLoginEvent,
  RuntimeAuthLoginResult,
  RuntimeAuthLogoutResult,
  RuntimeAuthProvider,
} from "@lrm/coforge-sdk/internal";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

/** How long a login or a sign-out stays readable, and how long its lock holds. */
export const RUNTIME_AUTH_TTL_SECONDS = 20 * 60;
/** A login whose daemon has not reported anything by now never started. */
export const RUNTIME_AUTH_START_WINDOW_MS = 10 * 60_000;
const CAS_ATTEMPTS = 5;

const COMPARE_AND_SET = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0`;
const COMPARE_AND_DELETE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;
const COMPARE_AND_EXPIRE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0`;
/** The lock and the login record are written together, so a lock never names a login with no record. */
const TAKE_LOCK_AND_BEGIN = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "EX", ARGV[3]) then
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
  return false
end
return redis.call("GET", KEYS[1])`;

type Scope = { workspaceId: string; computerId: string };
export type RuntimeAuthScope = Scope;

/** One sign-in, as the web keeps it. The pasted code is never part of it. */
export type RuntimeAuthLoginRecord = {
  loginId: string;
  provider: RuntimeAuthProvider;
  userId: string;
  startedAt: number;
  /** The last report applied; 0 until the daemon first answers. */
  sequence: number;
  event?: RuntimeAuthLoginEvent;
  result?: RuntimeAuthLoginResult;
};

export type RuntimeAuthLogoutRecord = {
  requestId: string;
  provider: RuntimeAuthProvider;
  userId: string;
  result?: RuntimeAuthLogoutResult;
};

/** `unknown`: no such open record. `ignored`: the report is stale or the record is already over. */
export type RuntimeAuthApplied<T> = T | "unknown" | "ignored";

export interface RuntimeAuthStore {
  /** Takes the provider's lock on this Computer for a new login, or says another login holds it. */
  begin(
    scope: Scope,
    login: Pick<RuntimeAuthLoginRecord, "loginId" | "provider" | "userId">,
    now: number,
  ): Promise<"started" | "busy">;
  /** The record, with the start window applied at `now`. */
  read(scope: Scope, loginId: string, now: number): Promise<RuntimeAuthLoginRecord | undefined>;
  /** Applies the daemon's report if it is newer than the last and the login is not over. */
  report(
    scope: Scope,
    loginId: string,
    sequence: number,
    report: { event: RuntimeAuthLoginEvent } | { result: RuntimeAuthLoginResult },
  ): Promise<RuntimeAuthApplied<RuntimeAuthLoginRecord>>;
  /** Ends a login the daemon will not report on (its intent never left). */
  fail(
    scope: Scope,
    loginId: string,
    result: RuntimeAuthLoginResult,
  ): Promise<RuntimeAuthApplied<RuntimeAuthLoginRecord>>;
  beginLogout(
    scope: Scope,
    logout: Pick<RuntimeAuthLogoutRecord, "requestId" | "provider" | "userId">,
  ): Promise<{ record: RuntimeAuthLogoutRecord; created: boolean }>;
  readLogout(scope: Scope, requestId: string): Promise<RuntimeAuthLogoutRecord | undefined>;
  reportLogout(
    scope: Scope,
    requestId: string,
    result: RuntimeAuthLogoutResult,
  ): Promise<RuntimeAuthApplied<RuntimeAuthLogoutRecord>>;
}

type RedisCommands = {
  get(key: string): Promise<string | null>;
  set(...args: string[]): Promise<unknown>;
  send(command: "EVAL", args: string[]): Promise<unknown>;
};

/** A lock names the Workspace its login lives in: a Computer may be connected to several. */
type LockHolder = { workspaceId: string; loginId: string };

export class RedisRuntimeAuthStore implements RuntimeAuthStore {
  constructor(private readonly redis: RedisCommands) {}

  async begin(
    scope: Scope,
    login: Pick<RuntimeAuthLoginRecord, "loginId" | "provider" | "userId">,
    now: number,
  ) {
    const lock = this.lockKey(scope.computerId, login.provider);
    const holder: LockHolder = { workspaceId: scope.workspaceId, loginId: login.loginId };
    const record: RuntimeAuthLoginRecord = { ...login, startedAt: now, sequence: 0 };
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const held = await this.redis.send("EVAL", [
        TAKE_LOCK_AND_BEGIN,
        "2",
        lock,
        this.loginKey(scope, login.loginId),
        JSON.stringify(holder),
        JSON.stringify(record),
        String(RUNTIME_AUTH_TTL_SECONDS),
      ]);
      if (typeof held !== "string") return "started";
      // A holder the daemon never answered, or one already over, must not keep the provider
      // locked until the lock expires.
      const other = this.parse<LockHolder>(held);
      const current =
        other &&
        (await this.read({ ...scope, workspaceId: other.workspaceId }, other.loginId, now));
      if (current && !current.result) return "busy";
      await this.redis.send("EVAL", [COMPARE_AND_DELETE, "1", lock, held]);
    }
    return "busy";
  }

  async read(scope: Scope, loginId: string, now: number) {
    const record = this.parse<RuntimeAuthLoginRecord>(
      await this.redis.get(this.loginKey(scope, loginId)),
    );
    if (!record || !this.neverStarted(record, now)) return record;
    const failed = await this.update(scope, loginId, (current) =>
      current.result || !this.neverStarted(current, now)
        ? undefined
        : { ...current, result: { kind: "failed", reason: "timed_out" } },
    );
    return typeof failed === "object"
      ? failed
      : this.parse<RuntimeAuthLoginRecord>(await this.redis.get(this.loginKey(scope, loginId)));
  }

  report(
    scope: Scope,
    loginId: string,
    sequence: number,
    report: { event: RuntimeAuthLoginEvent } | { result: RuntimeAuthLoginResult },
  ) {
    return this.update(scope, loginId, (record) => {
      if (record.result || sequence <= record.sequence) return undefined;
      return "event" in report
        ? { ...record, sequence, event: report.event }
        : { ...record, sequence, result: report.result };
    });
  }

  fail(scope: Scope, loginId: string, result: RuntimeAuthLoginResult) {
    return this.update(scope, loginId, (record) =>
      record.result ? undefined : { ...record, result },
    );
  }

  async beginLogout(
    scope: Scope,
    logout: Pick<RuntimeAuthLogoutRecord, "requestId" | "provider" | "userId">,
  ) {
    const key = this.logoutKey(scope, logout.requestId);
    const record: RuntimeAuthLogoutRecord = { ...logout };
    const created = await this.redis.set(
      key,
      JSON.stringify(record),
      "EX",
      String(RUNTIME_AUTH_TTL_SECONDS),
      "NX",
    );
    if (created !== null) return { record, created: true };
    const existing = this.parse<RuntimeAuthLogoutRecord>(await this.redis.get(key));
    if (!existing) throw new Error("Sign-out request could not be registered");
    return { record: existing, created: false };
  }

  async readLogout(scope: Scope, requestId: string) {
    return this.parse<RuntimeAuthLogoutRecord>(
      await this.redis.get(this.logoutKey(scope, requestId)),
    );
  }

  async reportLogout(
    scope: Scope,
    requestId: string,
    result: RuntimeAuthLogoutResult,
  ): Promise<RuntimeAuthApplied<RuntimeAuthLogoutRecord>> {
    const key = this.logoutKey(scope, requestId);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await this.redis.get(key);
      const record = this.parse<RuntimeAuthLogoutRecord>(current);
      if (!current || !record) return "unknown";
      if (record.result) return "ignored";
      const next = { ...record, result };
      if (await this.compareAndSet(key, current, next)) return next;
    }
    throw new Error("Sign-out report could not be applied");
  }

  /** A login nothing has answered by the end of the start window. */
  private neverStarted(record: RuntimeAuthLoginRecord, now: number) {
    return (
      !record.result &&
      record.sequence === 0 &&
      now - record.startedAt > RUNTIME_AUTH_START_WINDOW_MS
    );
  }

  /**
   * Replaces the login with `change`'s answer, or says why it did not. Ending a login frees the
   * provider's lock; the lock of a login found already over is freed too, in case that failed.
   */
  private async update(
    scope: Scope,
    loginId: string,
    change: (record: RuntimeAuthLoginRecord) => RuntimeAuthLoginRecord | undefined,
  ): Promise<RuntimeAuthApplied<RuntimeAuthLoginRecord>> {
    const key = this.loginKey(scope, loginId);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await this.redis.get(key);
      const record = this.parse<RuntimeAuthLoginRecord>(current);
      if (!current || !record) return "unknown";
      const next = change(record);
      if (!next) {
        if (record.result) await this.releaseLock(scope, record);
        return "ignored";
      }
      if (!(await this.compareAndSet(key, current, next))) continue;
      if (next.result) await this.releaseLock(scope, next);
      else await this.refreshLock(scope, next);
      return next;
    }
    throw new Error("Sign-in report could not be applied");
  }

  private releaseLock(scope: Scope, record: RuntimeAuthLoginRecord) {
    return this.redis.send("EVAL", [
      COMPARE_AND_DELETE,
      "1",
      this.lockKey(scope.computerId, record.provider),
      JSON.stringify({ workspaceId: scope.workspaceId, loginId: record.loginId }),
    ]);
  }

  /** A login that is still going keeps its lock as long as its record. */
  private refreshLock(scope: Scope, record: RuntimeAuthLoginRecord) {
    return this.redis.send("EVAL", [
      COMPARE_AND_EXPIRE,
      "1",
      this.lockKey(scope.computerId, record.provider),
      JSON.stringify({ workspaceId: scope.workspaceId, loginId: record.loginId }),
      String(RUNTIME_AUTH_TTL_SECONDS),
    ]);
  }

  private async compareAndSet(key: string, current: string, next: unknown) {
    return (
      (await this.redis.send("EVAL", [
        COMPARE_AND_SET,
        "1",
        key,
        current,
        JSON.stringify(next),
        String(RUNTIME_AUTH_TTL_SECONDS),
      ])) === 1
    );
  }

  private parse<T>(value: string | null): T | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  private base(scope: Scope) {
    return workspaceRedisKey({ ...scope, name: "runtime-auth", version: "v1" });
  }
  private loginKey(scope: Scope, loginId: string) {
    return `${this.base(scope)}:login:${encodeURIComponent(loginId)}`;
  }
  /** Per Computer, not per Workspace: the runtime's account is the Computer's. */
  private lockKey(computerId: string, provider: RuntimeAuthProvider) {
    return `coforge:computer:${encodeURIComponent(computerId)}:runtime-auth-lock:v1:${encodeURIComponent(provider)}`;
  }
  private logoutKey(scope: Scope, requestId: string) {
    return `${this.base(scope)}:logout:${encodeURIComponent(requestId)}`;
  }
}
