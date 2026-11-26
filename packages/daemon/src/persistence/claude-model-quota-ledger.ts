import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeModelWindow } from "@coforge/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

type ClaudeQuotaModel = RuntimeModelWindow["model"];

type ClaudeModelQuotaObservation = Readonly<{
  accountDigest: string;
  model: ClaudeQuotaModel;
  untilMs: number;
  observedAtMs: number;
}>;

const MAX_WINDOW_MS = 8 * 24 * 60 * 60_000;
const ACCOUNT_DIGEST = /^[0-9a-f]{64}$/;
export function isClaudeQuotaAccountDigest(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_DIGEST.test(value);
}

const logger = getLogger(["coforge", "daemon", "runtime"]);

function readObservation(value: unknown, now: number): ClaudeModelQuotaObservation | undefined {
  if (!isRecord(value)) return;
  const { accountDigest, model, untilMs, observedAtMs } = value;
  if (
    !isClaudeQuotaAccountDigest(accountDigest) ||
    (model !== "fable" && model !== "opus" && model !== "sonnet") ||
    typeof untilMs !== "number" ||
    !Number.isSafeInteger(untilMs) ||
    untilMs <= now ||
    typeof observedAtMs !== "number" ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs <= 0 ||
    observedAtMs > now ||
    untilMs - observedAtMs > MAX_WINDOW_MS
  )
    return;
  return { accountDigest, model, untilMs, observedAtMs };
}

export class ClaudeModelQuotaLedger {
  readonly #path: string;
  readonly #records = new Map<string, ClaudeModelQuotaObservation>();

  constructor(
    private readonly stateDirectory: string,
    now = Date.now(),
  ) {
    this.#path = join(stateDirectory, "claude-model-quota.json");
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.records)) return;
    for (const value of snapshot.records as unknown[]) {
      const record = readObservation(value, now);
      if (record) this.#remember(record);
    }
  }

  active(
    accountDigest: string | undefined,
    model: ClaudeQuotaModel,
    now = Date.now(),
  ): ClaudeModelQuotaObservation | undefined {
    if (!accountDigest) return;
    const key = `${accountDigest}:${model}`;
    const record = this.#records.get(key);
    if (!record) return;
    if (record.untilMs > now) return record;
    this.#records.delete(key);
    this.#save(now);
  }

  noteRejected(observation: ClaudeModelQuotaObservation, now = Date.now()): boolean {
    const record = readObservation(observation, now);
    if (!record || !this.#remember(record)) return false;
    this.#save(now);
    return true;
  }

  noteAvailable(observation: ClaudeModelQuotaObservation, now = Date.now()): boolean {
    const evidence = readObservation(observation, now);
    if (!evidence) return false;
    const record = this.active(evidence.accountDigest, evidence.model, now);
    if (
      !record ||
      record.untilMs !== evidence.untilMs ||
      evidence.observedAtMs <= record.observedAtMs
    )
      return false;
    this.#records.delete(`${evidence.accountDigest}:${evidence.model}`);
    this.#save(now);
    return true;
  }

  #remember(record: ClaudeModelQuotaObservation): boolean {
    const key = `${record.accountDigest}:${record.model}`;
    const previous = this.#records.get(key);
    if (
      previous &&
      (record.observedAtMs <= previous.observedAtMs || record.untilMs < previous.untilMs)
    )
      return false;
    this.#records.set(key, record);
    return true;
  }

  #save(now: number): void {
    for (const [key, record] of this.#records) {
      if (record.untilMs <= now) this.#records.delete(key);
    }
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, records: Array.from(this.#records.values()) })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, this.#path);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {}
      logger.warn("Claude model quota could not be recorded", {
        event: "agent.runtime.claude_model_quota_persist_failed",
        error_type: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
