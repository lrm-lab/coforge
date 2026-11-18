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

export function createToastStore() {
  let shown: Toast | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    current: () => shown,
    show(input: ToastInput) {
      shown = { ...input, revision: shown?.id === input.id ? shown.revision + 1 : 0 };
      emit();
    },
    dismiss(id: string) {
      if (shown?.id !== id) return;
      shown = null;
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
