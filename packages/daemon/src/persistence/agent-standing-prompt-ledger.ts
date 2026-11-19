import type { Database } from "bun:sqlite";
import { readMeta, writeMeta } from "./agent-state-db";

const STANDING_PROMPT_KEY = "standingPrompt";

export type StandingPromptRecord = Readonly<{
  hash: string;
  bytes: number;
  provider: string;
  sessionId?: string;
  recordedAtMs: number;
}>;

export type StandingPromptRecordInput = Readonly<{
  instructions: string;
  provider: string;
  sessionId?: string;
  nowMs?: number;
}>;

export type StandingPromptDiffResult = Readonly<{
  changed: boolean;
  isFirst: boolean;
  hash: string;
  bytes: number;
  previous?: StandingPromptRecord;
}>;

export type StandingPromptWriteResult = Readonly<{
  changed: boolean;
  isFirst: boolean;
  written: boolean;
  record: StandingPromptRecord;
  previous?: StandingPromptRecord;
}>;

export function standingPromptHash(instructions: string): string {
  return new Bun.CryptoHasher("sha256").update(instructions, "utf8").digest("base64url");
}

function parseStandingPromptRecord(raw: string | undefined): StandingPromptRecord | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StandingPromptRecord> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (typeof parsed.hash !== "string" || parsed.hash.length === 0) return undefined;
    if (typeof parsed.bytes !== "number" || !Number.isSafeInteger(parsed.bytes) || parsed.bytes < 0)
      return undefined;
    if (typeof parsed.provider !== "string" || parsed.provider.length === 0) return undefined;
    if (
      typeof parsed.recordedAtMs !== "number" ||
      !Number.isSafeInteger(parsed.recordedAtMs) ||
      parsed.recordedAtMs < 0
    )
      return undefined;
    const sessionId =
      typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
        ? parsed.sessionId
        : undefined;
    return {
      hash: parsed.hash,
      bytes: parsed.bytes,
      provider: parsed.provider,
      ...(sessionId ? { sessionId } : {}),
      recordedAtMs: parsed.recordedAtMs,
    };
  } catch {
    return undefined;
  }
}

export class AgentStandingPromptLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  read(): StandingPromptRecord | undefined {
    return parseStandingPromptRecord(readMeta(this.#db, STANDING_PROMPT_KEY));
  }

  diff(instructions: string): StandingPromptDiffResult {
    const hash = standingPromptHash(instructions);
    const bytes = Buffer.byteLength(instructions, "utf8");
    const previous = this.read();
    return {
      changed: previous !== undefined && previous.hash !== hash,
      isFirst: previous === undefined,
      hash,
      bytes,
      ...(previous ? { previous } : {}),
    };
  }

  record(input: StandingPromptRecordInput): StandingPromptWriteResult {
    const hash = standingPromptHash(input.instructions);
    const bytes = Buffer.byteLength(input.instructions, "utf8");
    const previous = this.read();
    const isFirst = previous === undefined;
    const changed = previous !== undefined && previous.hash !== hash;
    const sessionId = input.sessionId && input.sessionId.length > 0 ? input.sessionId : undefined;
    if (
      previous &&
      previous.hash === hash &&
      previous.bytes === bytes &&
      previous.provider === input.provider &&
      previous.sessionId === sessionId
    ) {
      return {
        changed: false,
        isFirst: false,
        written: false,
        record: previous,
        previous,
      };
    }
    const record: StandingPromptRecord = {
      hash,
      bytes,
      provider: input.provider,
      ...(sessionId ? { sessionId } : {}),
      recordedAtMs: input.nowMs ?? Date.now(),
    };
    writeMeta(this.#db, STANDING_PROMPT_KEY, JSON.stringify(record));
    return {
      changed,
      isFirst,
      written: true,
      record,
      ...(previous ? { previous } : {}),
    };
  }

  clear(): void {
    this.#db.prepare(`DELETE FROM meta WHERE key = ?`).run(STANDING_PROMPT_KEY);
  }
}
