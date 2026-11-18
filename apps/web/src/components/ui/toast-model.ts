import type { Transition } from "motion/react";

export type ToastIcon = "done" | "error" | "notice" | "progress" | "countdown";

export type ToastAction = { label: string; onClick: () => void };

export type ToastInput = {
  id: string;
  title: string;
  icon: ToastIcon;
  durationMs: number;
  action?: ToastAction;
};

export type Toast = ToastInput & { revision: number };

const MOST_WAITING = 3;

type Waiting = { input: ToastInput; since: number };

function stillDue({ input, since }: Waiting, now: number): ToastInput | null {
  const left = input.durationMs - (now - since);
  if (left <= 0) return null;
  return input.action ? { ...input, durationMs: left } : input;
}

function cutsIn(input: ToastInput, shown: Toast | null): boolean {
  return input.icon === "error" || (input.icon === "countdown" && shown?.icon === "countdown");
}

export function createToastStore(now: () => number = () => performance.now()) {
  let shown: Toast | null = null;
  let waiting: Waiting[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const showNext = () => {
    shown = null;
    while (!shown && waiting.length > 0) {
      const [next, ...rest] = waiting;
      waiting = rest;
      const due = stillDue(next!, now());
      if (due) shown = { ...due, revision: 0 };
    }
  };
  return {
    current: () => shown,
    show(input: ToastInput) {
      if (shown?.id === input.id) shown = { ...input, revision: shown.revision + 1 };
      else if (waiting.some((entry) => entry.input.id === input.id))
        waiting = waiting.map((entry) =>
          entry.input.id === input.id ? { ...entry, input } : entry,
        );
      else if (cutsIn(input, shown)) shown = { ...input, revision: 0 };
      else if (shown?.action || waiting.length > 0) {
        waiting = [...waiting, { input, since: now() }].slice(-MOST_WAITING);
        if (!shown?.action) showNext();
      } else shown = { ...input, revision: 0 };
      emit();
    },
    dismiss(id: string) {
      const waited = waiting.length;
      waiting = waiting.filter((entry) => entry.input.id !== id);
      if (shown?.id === id) showNext();
      else if (waiting.length === waited) return;
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function statusToastMs(title: string): number {
  return Math.min(5000, 3000 + Math.max(0, title.length - 12) * 40);
}

export const ACTION_TOAST_MS = 6000;
export const RESULT_TOAST_MS = 3000;
export const UNDONE_TOAST_MS = 1500;

export type Countdown = { durationMs: number; spentMs: number; runningSince: number | null };

export function startCountdown(durationMs: number, now: number): Countdown {
  return { durationMs, spentMs: 0, runningSince: now };
}

export function pauseCountdown(countdown: Countdown, now: number): Countdown {
  if (countdown.runningSince === null) return countdown;
  return {
    ...countdown,
    spentMs: countdown.spentMs + now - countdown.runningSince,
    runningSince: null,
  };
}

export function resumeCountdown(countdown: Countdown, now: number): Countdown {
  return countdown.runningSince === null ? { ...countdown, runningSince: now } : countdown;
}

export function countdownRemainingMs(countdown: Countdown, now: number): number {
  const running = countdown.runningSince === null ? 0 : now - countdown.runningSince;
  return Math.max(0, countdown.durationMs - countdown.spentMs - running);
}

export const TOAST_FADE: Transition = { duration: 0.15 };

export const SWIPE_DISMISS_PX = 80;
