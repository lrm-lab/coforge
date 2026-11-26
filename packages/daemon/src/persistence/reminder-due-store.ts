import { readdir, rename } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import { join } from "node:path";
import { REMINDER_DUE_MESSAGE_TYPE, type ReminderDue } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import type {
  ReminderDueRecord,
  ReminderDueRecordState,
  ReminderDueStore,
} from "#src/agent-reminder/reminder-due-record";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

const logger = getLogger(["coforge", "daemon", "reminder"]);
const nonEmptyString = z.string().min(1);

const reminderDueEnvelopeSchema = z.object({
  version: z.literal(1),
  occurrences: z.array(z.unknown()),
});

const reminderDueRecordSchema = z.object({
  state: z.enum(["received", "acknowledged", "delivered", "refused"] satisfies [
    ReminderDueRecordState,
    ...ReminderDueRecordState[],
  ]),
  due: z.looseObject({
    protocolMajor: z.literal(1),
    messageType: z.literal(REMINDER_DUE_MESSAGE_TYPE),
    occurrenceId: nonEmptyString,
    expiresAt: nonEmptyString,
    workspaceId: z.unknown().optional(),
    computerId: z.unknown().optional(),
    agentId: z.unknown().optional(),
    job: z.looseObject({
      reminderId: nonEmptyString,
      title: nonEmptyString,
      target: nonEmptyString,
      messageId: nonEmptyString,
      fireAt: nonEmptyString,
      version: z.int(),
      ownerAgentId: z.unknown().optional(),
    }),
  }),
  itemId: nonEmptyString.optional().catch(undefined),
  wokenAtMs: z.int().optional().catch(undefined),
});

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
    const parsed = reminderDueEnvelopeSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error("reminder due records are corrupt");
    return parsed.data.occurrences.map((entry) => this.#record(agentId, entry));
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
    const parsed = reminderDueRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error("reminder due records are corrupt");
    const { state, due, itemId, wokenAtMs } = parsed.data;
    if (
      due.workspaceId !== this.workspaceId ||
      due.computerId !== this.computerId ||
      due.agentId !== agentId ||
      due.job.ownerAgentId !== agentId
    )
      throw new Error("reminder due record belongs to another scope");
    return {
      state,
      due: structuredClone(due as ReminderDue),
      ...(itemId !== undefined ? { itemId } : {}),
      ...(wokenAtMs !== undefined ? { wokenAtMs } : {}),
    };
  }
}
