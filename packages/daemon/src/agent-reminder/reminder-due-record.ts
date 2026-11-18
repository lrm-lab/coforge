import type { ReminderDue } from "@lrm/coforge-sdk/internal";

export type ReminderDueRecordState = "received" | "acknowledged" | "delivered" | "refused";

export type ReminderDueRecord = {
  state: ReminderDueRecordState;
  due: ReminderDue;
  /** The App Inbox item the delivery created, kept so a restore can tell whether it is still there. */
  itemId?: string;
  /** When the wake pointing the Agent at that item returned success; absent means it never did. */
  wokenAtMs?: number;
};

export interface ReminderDueStore {
  agents(): Promise<string[]>;
  read(agentId: string): Promise<ReminderDueRecord[]>;
  write(agentId: string, records: readonly ReminderDueRecord[]): Promise<void>;
}

export const reminderDueExpired = (due: ReminderDue, nowMs: number) =>
  Date.parse(due.expiresAt) <= nowMs;
