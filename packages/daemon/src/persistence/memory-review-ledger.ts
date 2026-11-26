import type { Database } from "bun:sqlite";
import { z } from "zod";
import { readMeta, writeMeta } from "./agent-state-db";

export type MemoryReviewEntry = { key: string; revision: string };
export type MemoryReviewBatch = {
  id: string;
  humanAt: number;
  entries: MemoryReviewEntry[];
};
export type MemoryReviewState = {
  humanAt: number;
  usedHumanAt: number;
  lastStartedAt: number;
  active?: MemoryReviewBatch;
};
const STATE_KEY = "memoryReview.v1";
const PENDING_PREFIX = "memoryReview.pending:";

const memoryReviewEntrySchema = z.object({
  key: z.string(),
  revision: z.string(),
});

const memoryReviewBatchSchema = z.object({
  id: z.string(),
  humanAt: z.int(),
  entries: z.array(memoryReviewEntrySchema).max(5),
});

const memoryReviewStateSchema = z.object({
  humanAt: z.int().min(0),
  usedHumanAt: z.int().min(0),
  lastStartedAt: z.int().min(0),
  active: memoryReviewBatchSchema.optional(),
});

export class MemoryReviewLedger {
  constructor(private readonly db: Database) {}

  state(): MemoryReviewState {
    const raw = readMeta(this.db, STATE_KEY);
    if (!raw) return { humanAt: 0, usedHumanAt: 0, lastStartedAt: 0 };
    const parsed = memoryReviewStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("memory_review_invalid_state");
    return parsed.data;
  }

  save(state: MemoryReviewState): void {
    writeMeta(this.db, STATE_KEY, JSON.stringify(state));
  }

  noteHuman(createdAt: number): void {
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return;
    const state = this.state();
    if (createdAt <= Math.max(state.humanAt, state.lastStartedAt)) return;
    this.save({ ...state, humanAt: createdAt });
  }

  noteWrite(key: string, revision: string): void {
    const state = this.state();
    if (
      state.active &&
      state.active.humanAt === state.humanAt &&
      state.active.entries.some((entry) => entry.key === key)
    )
      return;
    writeMeta(this.db, `${PENDING_PREFIX}${key}`, revision);
  }

  pending(): MemoryReviewEntry[] {
    const rows = this.db
      .prepare(
        "SELECT key, value FROM meta WHERE key GLOB 'memoryReview.pending:*' ORDER BY rowid LIMIT 5",
      )
      .all() as { key: string; value: string }[];
    return rows.map((row) => ({ key: row.key.slice(PENDING_PREFIX.length), revision: row.value }));
  }

  finish(batchId: string, reviewed: readonly string[]): void {
    this.db.transaction(() => {
      const state = this.state();
      if (state.active?.id !== batchId) return;
      const remove = this.db.prepare("DELETE FROM meta WHERE key = ? AND value = ?");
      for (const entry of state.active.entries)
        if (reviewed.includes(entry.key))
          remove.run(`${PENDING_PREFIX}${entry.key}`, entry.revision);
      delete state.active;
      this.save(state);
    })();
  }
}
