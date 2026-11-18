import { describe, expect, test } from "bun:test";

import {
  countdownRemainingMs,
  createToastStore,
  pauseCountdown,
  resumeCountdown,
  startCountdown,
  statusToastMs,
  type ToastInput,
} from "#src/components/ui/toast-model";

const status = (id: string, title: string): ToastInput => ({
  id,
  title,
  icon: "done",
  durationMs: 3000,
});

describe("one toast at a time", () => {
  test("a new toast replaces the one on screen", () => {
    const store = createToastStore();
    store.show(status("a", "Link copied"));
    store.show(status("b", "Chat closed"));
    expect(store.current()?.id).toBe("b");
  });

  test("the same id changes the toast in place, as a new revision", () => {
    const store = createToastStore();
    store.show({ ...status("upload", "Uploading"), icon: "progress", durationMs: Infinity });
    const running = store.current();
    store.show(status("upload", "Uploaded"));
    expect(store.current()?.title).toBe("Uploaded");
    expect(store.current()?.revision).toBe((running?.revision ?? 0) + 1);
  });

  test("dismissing a toast that was already replaced leaves the new one", () => {
    const store = createToastStore();
    store.show(status("a", "Link copied"));
    store.show(status("b", "Chat closed"));
    store.dismiss("a");
    expect(store.current()?.id).toBe("b");
    store.dismiss("b");
    expect(store.current()).toBeNull();
  });

  test("a subscriber hears every change", () => {
    const store = createToastStore();
    let heard = 0;
    const stop = store.subscribe(() => (heard += 1));
    store.show(status("a", "Link copied"));
    store.dismiss("a");
    stop();
    store.show(status("b", "Chat closed"));
    expect(heard).toBe(2);
  });
});

describe("how long a status toast stays", () => {
  test("three seconds for a few words, up to five for a long line", () => {
    expect(statusToastMs("Copied")).toBe(3000);
    expect(statusToastMs("x".repeat(200))).toBe(5000);
    const middle = statusToastMs("Removed from saved, and the list shows it again");
    expect(middle).toBeGreaterThan(3000);
    expect(middle).toBeLessThan(5000);
  });
});

describe("the countdown behind an Undo", () => {
  test("time passes only while it runs", () => {
    let countdown = startCountdown(6000, 1000);
    expect(countdownRemainingMs(countdown, 2000)).toBe(5000);
    countdown = pauseCountdown(countdown, 2000);
    expect(countdownRemainingMs(countdown, 9000)).toBe(5000);
    countdown = resumeCountdown(countdown, 9000);
    expect(countdownRemainingMs(countdown, 10_000)).toBe(4000);
  });

  test("never goes below zero, and pausing twice changes nothing", () => {
    let countdown = startCountdown(1000, 0);
    countdown = pauseCountdown(pauseCountdown(countdown, 400), 900);
    expect(countdownRemainingMs(countdown, 5000)).toBe(600);
    expect(countdownRemainingMs(resumeCountdown(countdown, 5000), 99_000)).toBe(0);
  });
});
