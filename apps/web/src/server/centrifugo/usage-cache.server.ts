import { openRedisClient } from "#src/server/redis-client.server";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import {
  SCAN_RESULT_STALE_AFTER_MS,
  SCAN_RESULT_TTL_SECONDS,
  SCAN_TTL_SECONDS,
  readScanResult,
  scanResultKeys,
  type ScanResultRedisPort,
} from "./scan-result-cache.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

export type UsageCacheKey = {
  workspaceId: string;
  computerId: string;
  provider: RuntimeProvider;
};
export type UsageSnapshot = {
  provider: RuntimeProvider;
  planType?: string;
  primary?: {
    id?: string;
    usedPercent?: number;
    status?: "ok" | "limit_reached" | "parse_unavailable";
    windowDurationMinutes: number;
    resetsAt?: string;
  };
  secondary?: {
    id?: string;
    usedPercent?: number;
    status?: "ok" | "limit_reached" | "parse_unavailable";
    windowDurationMinutes: number;
    resetsAt?: string;
  };
  /** Official groups from a Computer that reports them. Older Computers omit this. */
  officialGroups?: {
    name?: string;
    description?: string;
    buckets: {
      id?: string;
      name?: string;
      description?: string;
      window?: string;
      remainingFraction?: number;
      usedPercent?: number;
      status?: "ok" | "limit_reached" | "parse_unavailable";
      windowDurationMinutes?: number;
      resetsAt?: string;
    }[];
  }[];
  /** The provider's own note above `officialGroups`. Older Computers omit this. */
  officialDescription?: string;
  /** Codex booleans, plus `balance` when that version's schema includes the string. */
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  creditUsage?: { used: number; limit: number; overage: number };
  /** Codex rate-limit reset credits the account can still spend, 0 to 999. Older Computers and
   * other runtimes omit it. */
  resetCreditsAvailable?: number;
  /** ISO instant the Computer actually observed this snapshot at. Older Computers omit it. */
  collectedAt?: string;
  /** The signed-in account, already masked on the Computer. Populated only when that provider's
   * usage/auth read reports it. */
  accountLabel?: string;
  /** Account-level health: `rate_limited` once any reported window is at its
   * limit, `ok` otherwise. Older Computers omit it. */
  health?: "ok" | "rate_limited" | "reauth_required" | "unsupported" | "error";
};

/** The last successful reading for one (Workspace, Computer, provider). It is written only by a
 * successful scan, so a failed attempt never erases it; reads pair it with the latest attempt. */
export type UsageResultRecord = UsageCacheKey & {
  scanId: string;
  status: "available" | "unavailable" | "reauth" | "unsupported" | "error";
  message?: string;
  snapshot?: UsageSnapshot;
  /** When this reading was actually observed: the snapshot's own `collectedAt` when the Computer
   * reported one, otherwise the time the server received it. The popover shows this as its age. */
  collectedAt: string;
  /** When the most recent scan attempt finished, which is what freshness is judged on. */
  lastAttemptAt?: string;
};

/** The latest scan attempt for one (Workspace, Computer, provider), success or failure. Stored
 * apart from the reading so recording a failure needs no read-modify-write of the reading. */
type UsageAttempt = {
  scanId: string;
  status: UsageResultRecord["status"];
  message?: string;
  occurredAt: string;
};

/** A scan the server asked the Computer to run and hasn't seen a result for yet. */
export type UsageScanRecord = UsageCacheKey & {
  scanId: string;
  status: "pending";
};

export type UsageReadResult = {
  state: "fresh" | "stale" | "missing";
  result?: UsageResultRecord;
  pendingScanId?: string;
};

/** A result older than this no longer represents "now" closely enough to show without a note. The
 * rule is the shared scan/result interval (`SCAN_RESULT_STALE_AFTER_MS`); it keeps
 * this name for this cache's readers. */
export const USAGE_STALE_AFTER_MS = SCAN_RESULT_STALE_AFTER_MS;

/** An attempt that failed stays fresh only this long. Long enough that several panels opening, or a
 * page reload, do not re-run the runtime's CLI each time; short enough that a transient failure is
 * retried soon instead of leaving the panel blank for the full window. A success keeps
 * `USAGE_STALE_AFTER_MS`. */
export const FAILED_USAGE_STALE_AFTER_MS = 2 * 60_000;

/** Lua that deletes the scan record at `key` when it belongs to the scan named by `scanId` (a Lua
 * expression), or is not a record at all. A result from an older scan never ends a newer one. */
const endOwnScan = (key: string, scanId: string) => `
local scan = redis.call("GET", ${key})
if scan then
  local ok, record = pcall(cjson.decode, scan)
  if not ok or type(record) ~= "table" or record.scanId == ${scanId} then
    redis.call("DEL", ${key})
  end
end`;

/**
 * A successful scan is one atomic fact across three keys: the reading, the attempt that produced
 * it, and the in-flight marker it ends. ARGV: the reading, the attempt, their TTL, then the scan
 * id; KEYS: the reading, the attempt, then the scan.
 */
const PUT_SUCCESS = `
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
${endOwnScan("KEYS[3]", "ARGV[4]")}
return 1
`;

/** A failed attempt records only itself and ends its own scan; the last reading is left untouched.
 * ARGV: the attempt, its TTL, then the scan id; KEYS: the attempt, then the scan. */
const PUT_ATTEMPT = `
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
${endOwnScan("KEYS[2]", "ARGV[3]")}
return 1
`;

/** Claims the scan record unless a pending scan stands, and answers the standing record. A record
 * that is not a pending scan (`readScanResult` would not call it in flight) is replaced. ARGV: the
 * record, then its lifetime; KEYS: the scan. One script, so two callers cannot both claim. */
const CLAIM_SCAN = `
if redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2], "NX") then return nil end
local standing = redis.call("GET", KEYS[1])
local ok, record = pcall(cjson.decode, standing)
if ok and type(record) == "table" and record.status == "pending" and type(record.scanId) == "string" then
  return standing
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return nil
`;

/** Ends the scan record when it is the named scan's own. ARGV: the scan id; KEYS: the scan. */
const RELEASE_SCAN = `${endOwnScan("KEYS[1]", "ARGV[1]")}
return 1
`;

export interface UsageCache {
  /**
   * Records a scan about to be asked for, unless one is already in flight for the same
   * (Workspace, Computer, provider), and answers the id of the scan in flight: the record's own
   * when it was recorded. The record expires by itself; a result ends it
   * (`putResult`), and so does `releaseScan`.
   */
  claimScan(record: UsageScanRecord): Promise<string>;
  /** Ends the scan in flight when it is `scanId`'s own: the caller's, that never got to run. */
  releaseScan(key: UsageCacheKey, scanId: string): Promise<void>;
  /** Ends whichever scan is in flight, because what it reads no longer holds: a runtime's login
   * changed, or a reset credit was spent. */
  endScan(key: UsageCacheKey): Promise<void>;
  putResult(record: UsageResultRecord): Promise<void>;
  read(key: UsageCacheKey): Promise<UsageReadResult>;
}

/** This cache writes several keys per result, so its port carries `eval`. */
type UsageCacheRedis = ScanResultRedisPort & {
  eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArgs: Array<string | number>
  ): Promise<unknown>;
};

export class RedisUsageCache implements UsageCache {
  constructor(
    private readonly redis: UsageCacheRedis,
    private readonly resultTtlSeconds = SCAN_RESULT_TTL_SECONDS,
    private readonly scanTtlSeconds = SCAN_TTL_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  async claimScan(record: UsageScanRecord) {
    const standing = await this.redis.eval(
      CLAIM_SCAN,
      1,
      scanResultKeys(this.scopeKey(record)).scan,
      JSON.stringify(record),
      this.scanTtlSeconds,
    );
    return typeof standing === "string"
      ? (parseJson<{ scanId: string }>(standing)?.scanId ?? record.scanId)
      : record.scanId;
  }

  async releaseScan(key: UsageCacheKey, scanId: string) {
    await this.redis.eval(RELEASE_SCAN, 1, scanResultKeys(this.scopeKey(key)).scan, scanId);
  }

  async endScan(key: UsageCacheKey) {
    await this.redis.del(scanResultKeys(this.scopeKey(key)).scan);
  }

  async putResult(record: UsageResultRecord) {
    const scope = this.scopeKey(record);
    const keys = scanResultKeys(scope);
    const attemptKey = `${scope}:attempt`;
    const occurredAt = new Date(this.now()).toISOString();
    if (record.status === "available") {
      await this.redis.eval(
        PUT_SUCCESS,
        3,
        keys.result,
        attemptKey,
        keys.scan,
        JSON.stringify(record),
        JSON.stringify({
          scanId: record.scanId,
          status: record.status,
          message: record.message,
          occurredAt,
        }),
        this.resultTtlSeconds,
        record.scanId,
      );
      return;
    }
    // A failed attempt never touches the reading: it only records itself, so the popover keeps
    // showing the last reading (and its own time) until a later scan replaces it.
    await this.redis.eval(
      PUT_ATTEMPT,
      2,
      attemptKey,
      keys.scan,
      JSON.stringify({
        scanId: record.scanId,
        status: record.status,
        message: record.message,
        occurredAt,
      }),
      this.resultTtlSeconds,
      record.scanId,
    );
  }

  async read(key: UsageCacheKey): Promise<UsageReadResult> {
    const scope = this.scopeKey(key);
    const keys = scanResultKeys(scope);
    const [reading, attemptRaw] = await Promise.all([
      readScanResult<UsageResultRecord>(this.redis, keys, USAGE_STALE_AFTER_MS, this.now()),
      this.redis.get(`${scope}:attempt`),
    ]);
    const attempt = parseJson<UsageAttempt>(attemptRaw);
    const pendingScanId = reading.pendingScanId;
    const lastSuccess = reading.result;
    if (!attempt) {
      // A cache written before attempts were recorded: judge the reading on its own time.
      return lastSuccess
        ? withState(
            lastSuccess.collectedAt,
            USAGE_STALE_AFTER_MS,
            this.now(),
            lastSuccess,
            pendingScanId,
          )
        : { state: "missing", pendingScanId };
    }
    const window =
      attempt.status === "available" ? USAGE_STALE_AFTER_MS : FAILED_USAGE_STALE_AFTER_MS;
    return withState(
      attempt.occurredAt,
      window,
      this.now(),
      mergedResult(key, attempt, lastSuccess),
      pendingScanId,
    );
  }

  private scopeKey(key: UsageCacheKey) {
    return `${workspaceRedisKey({
      workspaceId: key.workspaceId,
      computerId: key.computerId,
      name: "usage",
      version: "v2",
    })}:${encodeURIComponent(key.provider)}`;
  }
}

function withState(
  observedAt: string,
  staleAfterMs: number,
  now: number,
  result: UsageResultRecord,
  pendingScanId: string | undefined,
): UsageReadResult {
  const age = now - Date.parse(observedAt);
  return {
    state: Number.isFinite(age) && age <= staleAfterMs ? "fresh" : "stale",
    result,
    pendingScanId,
  };
}

/** The reading a viewer sees for the latest attempt: a transient failure keeps the last successful
 * reading and the time it was observed, while a sign-out (`reauth`) or a runtime that reports no
 * usage must not keep showing old quota. */
function mergedResult(
  key: UsageCacheKey,
  attempt: UsageAttempt,
  lastSuccess: UsageResultRecord | undefined,
): UsageResultRecord {
  if (attempt.status === "available" && lastSuccess)
    return { ...lastSuccess, scanId: attempt.scanId, lastAttemptAt: attempt.occurredAt };
  const transient = attempt.status === "unavailable" || attempt.status === "error";
  if (transient && lastSuccess?.snapshot)
    return {
      ...lastSuccess,
      scanId: attempt.scanId,
      status: attempt.status,
      message: attempt.message,
      lastAttemptAt: attempt.occurredAt,
    };
  return {
    ...key,
    scanId: attempt.scanId,
    status: attempt.status,
    message: attempt.message,
    collectedAt: attempt.occurredAt,
    lastAttemptAt: attempt.occurredAt,
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

let singleton: RedisUsageCache | undefined;
export function getUsageCache() {
  singleton ??= new RedisUsageCache(openRedisClient(redisUrlFor("usage cache")));
  return singleton;
}
