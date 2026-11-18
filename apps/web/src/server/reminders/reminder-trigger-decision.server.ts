import {
  REMINDER_TRIGGER_WAKES_PER_HOUR,
  type ReminderTriggerLevel,
} from "@lrm/coforge-sdk/internal";

const HOUR_MS = 3_600_000;

export type ReminderTriggerOutcome = "woke" | "merged" | "recorded" | "throttled";

export type ReminderTriggerState = {
  windowEndsAt: Date | null;
  pendingCount: number;
  firstPendingAt: Date | null;
};

export type ReminderTriggerReceipt = {
  triggerCount: number;
  firstTriggeredAt: Date;
  lastTriggeredAt: Date;
  nextWakeAllowedAt?: Date;
};

export type ReminderTriggerDecision = {
  outcome: ReminderTriggerOutcome;
  receipt: ReminderTriggerReceipt;
  nextState: ReminderTriggerState;
};

export function decideReminderTrigger(input: {
  level: ReminderTriggerLevel;
  mergeWindowSeconds: number;
  now: Date;
  state: ReminderTriggerState;
  wakesInLastHour: readonly Date[];
}): ReminderTriggerDecision {
  const { now, state } = input;
  const single = { triggerCount: 1, firstTriggeredAt: now, lastTriggeredAt: now };
  if (input.level === "log") return { outcome: "recorded", receipt: single, nextState: state };

  const carried = {
    triggerCount: state.pendingCount + 1,
    firstTriggeredAt: state.firstPendingAt ?? now,
    lastTriggeredAt: now,
  };
  const held = {
    windowEndsAt: state.windowEndsAt,
    pendingCount: state.pendingCount + 1,
    firstPendingAt: state.firstPendingAt ?? now,
  };

  const capLiftsAt = (at: Date): Date | undefined => {
    const counted = input.wakesInLastHour
      .filter((wake) => wake.getTime() > at.getTime() - HOUR_MS && wake <= now)
      .sort((a, b) => a.getTime() - b.getTime());
    return counted.length >= REMINDER_TRIGGER_WAKES_PER_HOUR
      ? new Date(counted[counted.length - REMINDER_TRIGGER_WAKES_PER_HOUR]!.getTime() + HOUR_MS)
      : undefined;
  };

  if (state.windowEndsAt && now < state.windowEndsAt) {
    const lifts = capLiftsAt(state.windowEndsAt);
    return {
      outcome: "merged",
      receipt: {
        ...carried,
        nextWakeAllowedAt: lifts && lifts > state.windowEndsAt ? lifts : state.windowEndsAt,
      },
      nextState: held,
    };
  }

  const lifts = capLiftsAt(now);
  if (lifts)
    return {
      outcome: "throttled",
      receipt: { ...carried, nextWakeAllowedAt: lifts },
      nextState: held,
    };

  const windowEndsAt = new Date(now.getTime() + input.mergeWindowSeconds * 1000);
  return {
    outcome: "woke",
    receipt: { ...carried, nextWakeAllowedAt: windowEndsAt },
    nextState: { windowEndsAt, pendingCount: 0, firstPendingAt: null },
  };
}
