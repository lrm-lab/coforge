import { readdir, rename } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import { join } from "node:path";
import { REMINDER_DUE_MESSAGE_TYPE, type ReminderDue } from "@lrm/coforge-sdk/internal";
import type {
  ReminderDueRecord,
  ReminderDueRecordState,
  ReminderDueStore,
} from "#src/agent-reminder/reminder-due-record";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

const logger = getLogger(["coforge", "daemon", "reminder"]);
const STATES: ReadonlySet<string> = new Set<ReminderDueRecordState>([
  "received",
  "acknowledged",
  "delivered",
  "refused",
]);
const JOB_TEXT = ["reminderId", "title", "target", "messageId", "fireAt"] as const;

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

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
    const path = this.#path(agentId);
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    try {
      return this.#parse(agentId, text);
    } catch (error) {
      await this.#quarantine(agentId, path, error);
      return [];
    }
  }

  async write(agentId: string, records: readonly ReminderDueRecord[]): Promise<void> {
    const occurrences = records.map((record) => this.#record(agentId, record));
    await writePrivateJsonRecord(
      this.#path(agentId),
      { version: 1, occurrences },
      { durable: true },
    );
  }

  #parse(agentId: string, text: string): ReminderDueRecord[] {
    const value = JSON.parse(text) as { version?: unknown; occurrences?: unknown } | null;
    if (value?.version !== 1 || !Array.isArray(value.occurrences))
      throw new Error("reminder due records are corrupt");
    return value.occurrences.map((entry) => this.#record(agentId, entry));
  }

  async #quarantine(agentId: string, path: string, error: unknown): Promise<void> {
    const aside = `${path}.corrupt-${Date.now()}`;
    let setAside = true;
    try {
      await rename(path, aside);
    } catch {
      setAside = false;
    }
    logger.error("Reminder due records were unreadable; this Agent starts from an empty record", {
      event: "reminder.due_records_quarantined",
      agent_id: agentId,
      ...(setAside ? { quarantined_to: aside } : {}),
      error,
    });
  }

  #record(agentId: string, value: unknown): ReminderDueRecord {
    const entry = value as {
      state?: unknown;
      due?: Partial<ReminderDue>;
      itemId?: unknown;
      wokenAtMs?: unknown;
    } | null;
    const due = entry?.due;
    const job = due?.job as Record<string, unknown> | undefined;
    if (
      !entry ||
      !STATES.has(entry.state as string) ||
      !due ||
      !job ||
      due.protocolMajor !== 1 ||
      due.messageType !== REMINDER_DUE_MESSAGE_TYPE ||
      !text(due.occurrenceId) ||
      !text(due.expiresAt) ||
      !JOB_TEXT.every((key) => text(job[key])) ||
      !Number.isSafeInteger(job.version)
    )
      throw new Error("reminder due records are corrupt");
    if (
      due.workspaceId !== this.workspaceId ||
      due.computerId !== this.computerId ||
      due.agentId !== agentId ||
      job.ownerAgentId !== agentId
    )
      throw new Error("reminder due record belongs to another scope");
    return {
      state: entry.state as ReminderDueRecordState,
      due: structuredClone(due as ReminderDue),
      ...(text(entry.itemId) ? { itemId: entry.itemId } : {}),
      ...(Number.isSafeInteger(entry.wokenAtMs) ? { wokenAtMs: entry.wokenAtMs as number } : {}),
    };
  }
}
