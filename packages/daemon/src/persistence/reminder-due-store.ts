import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { decodeReminderDue, encodeReminderDue } from "@lrm/coforge-sdk/internal";
import type {
  ReminderDueRecord,
  ReminderDueRecordState,
  ReminderDueStore,
} from "#src/agent-reminder/reminder-due-record";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

const STATES: ReadonlySet<ReminderDueRecordState> = new Set([
  "received",
  "acknowledged",
  "delivered",
  "refused",
]);

export class FileReminderDueStore implements ReminderDueStore {
  constructor(
    private readonly stateDirectory: string,
    private readonly workspaceId: string,
    private readonly computerId: string,
  ) {
    if (!stateDirectory || !isSafePathScope(workspaceId) || !isSafePathScope(computerId))
      throw new Error("invalid reminder due scope");
  }

  #root() {
    return join(this.stateDirectory, "reminder-due", this.workspaceId);
  }

  #path(agentId: string) {
    if (!isSafePathScope(agentId)) throw new Error("invalid reminder due Agent scope");
    return join(this.#root(), agentId, "occurrences.json");
  }

  async agents(): Promise<string[]> {
    try {
      const entries = await readdir(this.#root(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && isSafePathScope(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async read(agentId: string): Promise<ReminderDueRecord[]> {
    const file = Bun.file(this.#path(agentId));
    if (!(await file.exists())) return [];
    const value = JSON.parse(await file.text()) as { version?: unknown; occurrences?: unknown };
    if (value.version !== 1 || !Array.isArray(value.occurrences))
      throw new Error("reminder due records are corrupt");
    return value.occurrences.map((entry) => this.#record(agentId, entry));
  }

  async write(agentId: string, records: readonly ReminderDueRecord[]): Promise<void> {
    const occurrences = records.map((record) => ({
      state: record.state,
      due: Buffer.from(encodeReminderDue(this.#owned(agentId, record).due)).toString("base64"),
    }));
    await writePrivateJsonRecord(this.#path(agentId), { version: 1, occurrences });
  }

  #record(agentId: string, value: unknown): ReminderDueRecord {
    const entry = value as { state?: unknown; due?: unknown } | null;
    if (
      !entry ||
      typeof entry.due !== "string" ||
      !STATES.has(entry.state as ReminderDueRecordState)
    )
      throw new Error("reminder due records are corrupt");
    const due = decodeReminderDue(Buffer.from(entry.due, "base64"));
    return this.#owned(agentId, { state: entry.state as ReminderDueRecordState, due });
  }

  #owned(agentId: string, record: ReminderDueRecord): ReminderDueRecord {
    const { due } = record;
    if (
      due.workspaceId !== this.workspaceId ||
      due.computerId !== this.computerId ||
      due.agentId !== agentId
    )
      throw new Error("reminder due record belongs to another scope");
    return record;
  }
}
