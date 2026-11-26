import type { Database } from "bun:sqlite";
import type { SessionResumeFacts } from "@lrm/coforge-anvil";
import { z } from "zod";
import { readMeta, writeMeta } from "./agent-state-db";

const SESSION_SUMMARY_KEY = "sessionSummary";

export type SessionSummaryRecord = Readonly<{
  sessionId: string;
  provider: string;
  lastActivityAtMs: number;
  lastContextTokens?: number;
  lastContextObservedAtMs?: number;
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

const positiveSafeIntSchema = z.number().positive().transform(Math.trunc).pipe(z.int().positive());
const nonNegativeSafeIntSchema = z.number().nonnegative().transform(Math.trunc).pipe(z.int());

const sessionSummaryRecordSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  lastActivityAtMs: nonNegativeSafeIntSchema,
  updatedAtMs: nonNegativeSafeIntSchema,
  lastContextTokens: positiveSafeIntSchema.optional().catch(undefined),
  lastContextObservedAtMs: nonNegativeSafeIntSchema.optional().catch(undefined),
  windowTokens: positiveSafeIntSchema.optional().catch(undefined),
});

function parseSessionSummaryRecord(raw: string | undefined): SessionSummaryRecord | undefined {
  if (!raw) return undefined;
  try {
    const parsed = sessionSummaryRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const {
      sessionId,
      provider,
      lastActivityAtMs,
      lastContextTokens,
      lastContextObservedAtMs,
      windowTokens,
      updatedAtMs,
    } = parsed.data;
    return {
      sessionId,
      provider,
      lastActivityAtMs,
      ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
      ...(lastContextObservedAtMs !== undefined ? { lastContextObservedAtMs } : {}),
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
      ...(record.lastContextObservedAtMs !== undefined
        ? { lastContextObservedAtMs: record.lastContextObservedAtMs }
        : {}),
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
    if (
      sameSession &&
      previous.lastContextObservedAtMs !== undefined &&
      observedAtMs < previous.lastContextObservedAtMs
    )
      return previous;
    const lastActivityAtMs = sameSession
      ? Math.max(previous.lastActivityAtMs, observedAtMs)
      : observedAtMs;
    const windowTokens =
      positiveSafeInt(input.windowTokens) ?? (sameSession ? previous.windowTokens : undefined);
    if (
      sameSession &&
      previous.provider === input.provider &&
      previous.lastContextTokens === usedTokens &&
      previous.lastContextObservedAtMs === observedAtMs &&
      previous.windowTokens === windowTokens &&
      previous.lastActivityAtMs === lastActivityAtMs
    )
      return previous;
    const next: SessionSummaryRecord = {
      sessionId: input.sessionId,
      provider: input.provider,
      lastActivityAtMs,
      lastContextTokens: usedTokens,
      lastContextObservedAtMs: observedAtMs,
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
    const lastContextObservedAtMs = lastContextTokens === undefined ? undefined : nowMs;
    const windowTokens =
      positiveSafeInt(input.windowTokens) ?? (sameSession ? previous.windowTokens : undefined);
    if (
      sameSession &&
      previous.provider === input.provider &&
      previous.lastContextTokens === lastContextTokens &&
      previous.lastContextObservedAtMs === lastContextObservedAtMs &&
      previous.windowTokens === windowTokens &&
      previous.lastActivityAtMs === lastActivityAtMs
    )
      return previous;
    const next: SessionSummaryRecord = {
      sessionId: input.sessionId,
      provider: input.provider,
      lastActivityAtMs,
      ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
      ...(lastContextObservedAtMs !== undefined ? { lastContextObservedAtMs } : {}),
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
    const lastContextObservedAtMs = sameSession ? previous.lastContextObservedAtMs : undefined;
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
      ...(lastContextObservedAtMs !== undefined ? { lastContextObservedAtMs } : {}),
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
