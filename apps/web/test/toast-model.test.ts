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

const undo = (id: string, title: string): ToastInput => ({
  id,
  title,
  icon: "countdown",
  durationMs: 6000,
  action: { label: "Undo", onClick: () => undefined },
});

describe("a toast with an action is not cut short", () => {
  test("a new toast waits while the one on screen holds an action, then shows", () => {
    const store = createToastStore();
    store.show(undo("deleted", "Task deleted"));
    store.show(status("copied", "Link copied"));
    expect(store.current()?.id).toBe("deleted");
    store.dismiss("deleted");
    expect(store.current()?.id).toBe("copied");
  });

  test("waiting toasts show in the order they came", () => {
    const store = createToastStore();
    store.show(undo("closed-a", "Chat closed"));
    store.show({ ...undo("made", "Task #4 made"), icon: "done" });
    store.show(status("copied", "Link copied"));
    store.dismiss("closed-a");
    expect(store.current()?.id).toBe("made");
    store.dismiss("made");
    expect(store.current()?.id).toBe("copied");
  });

  test("the toast with the action still changes in place", () => {
    const store = createToastStore();
    store.show(undo("deleted", "Task deleted"));
    store.show(status("copied", "Link copied"));
    store.show(status("deleted", "Restored"));
    expect(store.current()?.title).toBe("Restored");
    store.show(status("next", "Chat closed"));
    expect(store.current()?.id).toBe("copied");
  });

  test("a waiting toast is updated where it waits, or dropped when dismissed", () => {
    const store = createToastStore();
    store.show(undo("deleted", "Task deleted"));
    store.show({ ...status("upload", "Uploading"), icon: "progress", durationMs: Infinity });
    store.show(status("upload", "Uploaded"));
    store.show(status("copied", "Link copied"));
    store.dismiss("copied");
    store.dismiss("deleted");
    expect(store.current()?.title).toBe("Uploaded");
    store.dismiss("upload");
    expect(store.current()).toBeNull();
  });
});

describe("waiting never outlives the toast", () => {
  test("a toast with an action that waited shows only the time it has left, and is dropped once that is gone", () => {
    let now = 0;
    const store = createToastStore(() => now);
    const made = (id: string): ToastInput => ({ ...undo(id, "Task made"), icon: "done" });
    store.show(undo("closed", "Chat closed"));
    store.show(made("made-b"));
    store.show(made("made-c"));
    now = 2000;
    store.dismiss("closed");
    expect(store.current()?.id).toBe("made-b");
    expect(store.current()?.durationMs).toBe(4000);
    now = 7000;
    store.dismiss("made-b");
    expect(store.current()).toBeNull();
  });

  test("a status that waited past its own time is dropped", () => {
    let now = 0;
    const store = createToastStore(() => now);
    store.show(undo("deleted", "Task deleted"));
    store.show(status("copied", "Link copied"));
    now = 3500;
    store.dismiss("deleted");
    expect(store.current()).toBeNull();
  });

  test("a new toast never jumps ahead of the ones already waiting", () => {
    const store = createToastStore();
    store.show(undo("deleted", "Task deleted"));
    store.show(status("copied", "Link copied"));
    store.show({ ...status("deleted", "Restoring"), icon: "progress", durationMs: Infinity });
    store.show(status("saved", "Saved"));
    expect(store.current()?.id).toBe("copied");
    store.dismiss("copied");
    expect(store.current()?.id).toBe("saved");
  });

  test("at most three wait; the oldest gives way", () => {
    const store = createToastStore();
    store.show(undo("deleted", "Task deleted"));
    for (const id of ["a", "b", "c", "d"]) store.show(status(id, id));
    store.dismiss("deleted");
    expect(store.current()?.id).toBe("b");
  });
});

describe("what does not wait", () => {
  test("an error replaces even a toast with an action, and the queue still follows it", () => {
    const store = createToastStore();
    store.show(undo("deleted", "Task deleted"));
    store.show(status("copied", "Link copied"));
    store.show({ ...status("send", "Could not send"), icon: "error" });
    expect(store.current()?.id).toBe("send");
    store.dismiss("send");
    expect(store.current()?.id).toBe("copied");
  });

  test("a new Undo replaces the Undo on screen", () => {
    const store = createToastStore();
    store.show(undo("closed-a", "Chat closed"));
    store.show(undo("closed-b", "Chat closed"));
    expect(store.current()?.id).toBe("closed-b");
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
