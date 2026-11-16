import { cloudFired, type ReminderReceipt } from "./reminder-receipt";

export const RETRY_BUDGET_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 8;
const FIRE_RECONCILE_MS = 5 * 60_000;
const FIRE_RECONCILE_JITTER = 0.1;
const WAKE_RETRY_MS = 60_000;

export function retryBackoff(attempt: number) {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export const retryHorizon = (receipt: ReminderReceipt) =>
  receipt.retryExhausted ? Infinity : receipt.deadline;

export function budgetSpent(receipt: ReminderReceipt, now: number): boolean {
  return receipt.attempt >= MAX_ATTEMPTS || now >= receipt.deadline;
}

export function retryDelay(receipt: ReminderReceipt, random: () => number): number {
  if (!receipt.retryExhausted) return retryBackoff(receipt.attempt);
  if (cloudFired(receipt)) return WAKE_RETRY_MS;
  return FIRE_RECONCILE_MS * (1 - FIRE_RECONCILE_JITTER + random() * 2 * FIRE_RECONCILE_JITTER);
}
