import type { Database } from "bun:sqlite";
import type { SessionResumeFacts } from "@lrm/coforge-anvil";
import { readMeta, writeMeta } from "./agent-state-db";

const SESSION_SUMMARY_KEY = "sessionSummary";

export type SessionSummaryRecord = Readonly<{
  sessionId: string;
  provider: string;
  lastActivityAtMs: number;
  lastContextTokens?: number;
  windowTokens?: number;
  updatedAtMs: number;
}>;

export type SessionSummaryContextInput = Readonly<{
  sessionId: string;
  provider: string;
  usedTokens: number;
  windowTokens?: number;
  observedAtMs?: number;
  nowMs?: number;
}>;

export type SessionSummaryCompactionInput = Readonly<{
  sessionId: string;
  provider: string;
  tokensAfter?: number;
  windowTokens?: number;
  nowMs?: number;
}>;

export type SessionSummaryActivityInput = Readonly<{
  sessionId: string;
  provider: string;
  atMs?: number;
  nowMs?: number;
}>;

function positiveSafeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const rounded = Math.trunc(value);
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : undefined;
}

function nonNegativeSafeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const rounded = Math.trunc(value);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : undefined;
}

function parseSessionSummaryRecord(raw: string | undefined): SessionSummaryRecord | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionSummaryRecord> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return undefined;
    if (typeof parsed.provider !== "string" || parsed.provider.length === 0) return undefined;
    const lastActivityAtMs = nonNegativeSafeInt(parsed.lastActivityAtMs);
    const updatedAtMs = nonNegativeSafeInt(parsed.updatedAtMs);
    if (lastActivityAtMs === undefined || updatedAtMs === undefined) return undefined;
    const lastContextTokens = positiveSafeInt(parsed.lastContextTokens);
    const windowTokens = positiveSafeInt(parsed.windowTokens);
    return {
      sessionId: parsed.sessionId,
      provider: parsed.provider,
      lastActivityAtMs,
      ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      updatedAtMs,
    };
  } catch {
    return undefined;
  }
}

export class AgentSessionSummaryLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  read(): SessionSummaryRecord | undefined {
    return parseSessionSummaryRecord(readMeta(this.#db, SESSION_SUMMARY_KEY));
  }

  resumeFacts(sessionId: string): SessionResumeFacts | undefined {
    if (!sessionId) return undefined;
    const record = this.read();
    if (!record || record.sessionId !== sessionId || record.lastContextTokens === undefined)
      return undefined;
    return {
      lastActivityAtMs: record.lastActivityAtMs,
      lastContextTokens: record.lastContextTokens,
    };
  }

  recordContextUsage(input: SessionSummaryContextInput): SessionSummaryRecord | undefined {
    if (!input.sessionId || !input.provider) return undefined;
    const usedTokens = positiveSafeInt(input.usedTokens);
    if (usedTokens === undefined) return undefined;
    const nowMs = nonNegativeSafeInt(input.nowMs) ?? Date.now();
    const observedAtMs = nonNegativeSafeInt(input.observedAtMs) ?? nowMs;
    const previous = this.read();
    const sameSession = previous?.sessionId === input.sessionId;
    const lastActivityAtMs = sameSession
      ? Math.max(previous.lastActivityAtMs, observedAtMs)
      : observedAtMs;
    const windowTokens =
      positiveSafeInt(input.windowTokens) ?? (sameSession ? previous.windowTokens : undefined);
    if (
      sameSession &&
      previous.provider === input.provider &&
      previous.lastContextTokens === usedTokens &&
      previous.windowTokens === windowTokens &&
      previous.lastActivityAtMs === lastActivityAtMs
    )
      return previous;
    const next: SessionSummaryRecord = {
      sessionId: input.sessionId,
      provider: input.provider,
      lastActivityAtMs,
      lastContextTokens: usedTokens,
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      updatedAtMs: nowMs,
    };
    writeMeta(this.#db, SESSION_SUMMARY_KEY, JSON.stringify(next));
    return next;
  }

  recordCompaction(input: SessionSummaryCompactionInput): SessionSummaryRecord | undefined {
    if (!input.sessionId || !input.provider) return undefined;
    const nowMs = nonNegativeSafeInt(input.nowMs) ?? Date.now();
    const previous = this.read();
    const sameSession = previous?.sessionId === input.sessionId;
    const lastActivityAtMs = sameSession ? Math.max(previous.lastActivityAtMs, nowMs) : nowMs;
    const lastContextTokens = positiveSafeInt(input.tokensAfter);
    const windowTokens =
      positiveSafeInt(input.windowTokens) ?? (sameSession ? previous.windowTokens : undefined);
    if (
      sameSession &&
      previous.provider === input.provider &&
      previous.lastContextTokens === lastContextTokens &&
      previous.windowTokens === windowTokens &&
      previous.lastActivityAtMs === lastActivityAtMs
    )
      return previous;
    const next: SessionSummaryRecord = {
      sessionId: input.sessionId,
      provider: input.provider,
      lastActivityAtMs,
      ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      updatedAtMs: nowMs,
    };
    writeMeta(this.#db, SESSION_SUMMARY_KEY, JSON.stringify(next));
    return next;
  }

  recordActivity(input: SessionSummaryActivityInput): SessionSummaryRecord | undefined {
    if (!input.sessionId || !input.provider) return undefined;
    const nowMs = nonNegativeSafeInt(input.nowMs) ?? Date.now();
    const atMs = nonNegativeSafeInt(input.atMs) ?? nowMs;
    const previous = this.read();
    const sameSession = previous?.sessionId === input.sessionId;
    const lastActivityAtMs = sameSession ? Math.max(previous.lastActivityAtMs, atMs) : atMs;
    const lastContextTokens = sameSession ? previous.lastContextTokens : undefined;
    const windowTokens = sameSession ? previous.windowTokens : undefined;
    if (
      sameSession &&
      previous.provider === input.provider &&
      previous.lastActivityAtMs === lastActivityAtMs
    )
      return previous;
    const next: SessionSummaryRecord = {
      sessionId: input.sessionId,
      provider: input.provider,
      lastActivityAtMs,
      ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      updatedAtMs: nowMs,
    };
    writeMeta(this.#db, SESSION_SUMMARY_KEY, JSON.stringify(next));
    return next;
  }

  clear(): void {
    this.#db.prepare(`DELETE FROM meta WHERE key = ?`).run(SESSION_SUMMARY_KEY);
  }
}
