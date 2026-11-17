import type { ReminderDue } from "@lrm/coforge-sdk/internal";

export type ReminderDueRecordState = "received" | "acknowledged" | "delivered" | "refused";

export type ReminderDueRecord = { state: ReminderDueRecordState; due: ReminderDue };

export interface ReminderDueStore {
  agents(): Promise<string[]>;
  read(agentId: string): Promise<ReminderDueRecord[]>;
  write(agentId: string, records: readonly ReminderDueRecord[]): Promise<void>;
}

export const reminderDueExpired = (due: ReminderDue, nowMs: number) =>
  Date.parse(due.expiresAt) <= nowMs;
