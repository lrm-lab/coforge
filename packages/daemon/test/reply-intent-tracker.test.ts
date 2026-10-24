import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import {
  REPLY_INTENT_MAX_LIVE_PER_AGENT,
  REPLY_INTENT_MAX_MS,
  REPLY_INTENT_REFRESH_MS,
} from "@lrm/coforge-sdk/internal/reply-intent";
import {
  ReplyIntentTracker,
  type ReplyIntentSignal,
} from "#src/daemon-runtime/reply-intent-tracker";

/** A tracker on a clock and an interval the test advances; `signals` is what it emitted. */
function tracker(emit?: (signal: ReplyIntentSignal) => void) {
  let now = 0;
  const signals: ReplyIntentSignal[] = [];
  const intervals = new Map<number, { callback: () => void; everyMs: number; next: number }>();
  let nextId = 0;
  const subject = new ReplyIntentTracker({
    emit: (signal) => {
      signals.push(signal);
      emit?.(signal);
    },
    now: () => now,
    every: (callback, everyMs) => {
      const id = nextId++;
      intervals.set(id, { callback, everyMs, next: now + everyMs });
      return () => intervals.delete(id);
    },
  });
  return {
    subject,
    signals,
    liveIntervals: () => intervals.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...intervals.values()]
          .filter((interval) => interval.next <= target)
          .sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.everyMs;
        due.callback();
      }
      now = target;
    },
  };
}

const send = (id: string, command = "coforge message send --target '#general' <<'X'\nhi\nX") =>
  ({ type: "tool-start", id, name: "bash", input: { command } }) satisfies AgentRuntimeEvent;
const end = (id: string) => ({ type: "tool-end", id, isError: false }) satisfies AgentRuntimeEvent;

test("a message send announces its target at once; other tool calls announce nothing", () => {
  const { subject, signals } = tracker();
  subject.observe({ type: "tool-start", id: "c0", name: "bash", input: { command: "ls" } });
  subject.observe({
    type: "tool-start",
    id: "c0b",
    name: "bash",
    input: { command: "coforge message send --help" },
  });
  expect(signals).toEqual([]);
  subject.observe(send("c1"));
  expect(signals).toEqual([{ phase: "start", callId: "c1", target: "#general" }]);
});

test("a subagent's send is not announced", () => {
  const { subject, signals } = tracker();
  subject.observe({
    ...send("c1"),
    subagent: { parentToolUseId: "parent-1" },
  });
  expect(signals).toEqual([]);
});

test("the start is repeated every refresh period while the call runs", () => {
  const { subject, signals, advance } = tracker();
  subject.observe(send("c1"));
  advance(REPLY_INTENT_REFRESH_MS - 1);
  expect(signals).toHaveLength(1);
  advance(1);
  expect(signals).toHaveLength(2);
  advance(REPLY_INTENT_REFRESH_MS);
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal.phase === "start" && signal.target === "#general")).toBe(
    true,
  );
});

test("an end repeats the target its start announced, so the server can route it the same way", () => {
  const { subject, signals } = tracker();
  subject.observe(early("c1", "@bob"));
  subject.observe(end("c1"));
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "@bob" });
});

test("a tracker runs one interval for all its calls, and only while one is live", () => {
  const { subject, signals, advance, liveIntervals } = tracker();
  expect(liveIntervals()).toBe(0);
  subject.observe(send("c1"));
  subject.observe(send("c2"));
  expect(liveIntervals()).toBe(1);
  advance(REPLY_INTENT_REFRESH_MS);
  expect(signals.filter((signal) => signal.phase === "start").map((s) => s.callId)).toEqual([
    "c1",
    "c2",
    "c1",
    "c2",
  ]);
  subject.observe(end("c1"));
  expect(liveIntervals()).toBe(1);
  subject.observe(end("c2"));
  expect(liveIntervals()).toBe(0);
  subject.observe(send("c3"));
  expect(liveIntervals()).toBe(1);
});

test("the call's end announces the end once and stops the repeats", () => {
  const { subject, signals, advance, liveIntervals } = tracker();
  subject.observe(send("c1"));
  subject.observe(end("c1"));
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
  expect(liveIntervals()).toBe(0);
  const count = signals.length;
  advance(REPLY_INTENT_MAX_MS);
  subject.observe(end("c1"));
  subject.observe(end("never-started"));
  expect(signals).toHaveLength(count);
});

test("the same call reported twice is announced once", () => {
  const { subject, signals } = tracker();
  subject.observe(send("c1"));
  subject.observe(send("c1"));
  expect(signals).toHaveLength(1);
});

test("a completed turn ends every live call", () => {
  const { subject, signals, liveIntervals } = tracker();
  subject.observe(send("c1"));
  subject.observe(send("c2"));
  subject.observe({ type: "completed", status: "interrupted" });
  expect(signals.filter((signal) => signal.phase === "end").map((s) => s.callId)).toEqual([
    "c1",
    "c2",
  ]);
  expect(liveIntervals()).toBe(0);
});

test("clearing a tracker ends live calls but allows a later turn to announce again", () => {
  const { subject, signals, liveIntervals } = tracker();
  subject.observe(send("c1"));
  subject.clear();
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
  expect(liveIntervals()).toBe(0);
  subject.observe(send("c2"));
  expect(signals.at(-1)).toEqual({ phase: "start", callId: "c2", target: "#general" });
  expect(liveIntervals()).toBe(1);
});

test("disposing ends every live call and later events announce nothing", () => {
  const { subject, signals, liveIntervals } = tracker();
  subject.observe(send("c1"));
  subject.dispose();
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
  expect(liveIntervals()).toBe(0);
  const count = signals.length;
  subject.observe(send("c2"));
  expect(signals).toHaveLength(count);
});

test("a call is announced for at most two minutes, then ended", () => {
  const { subject, signals, advance, liveIntervals } = tracker();
  subject.observe(send("c1"));
  advance(REPLY_INTENT_MAX_MS - 1);
  expect(signals.at(-1)?.phase).toBe("start");
  advance(1);
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
  expect(liveIntervals()).toBe(0);
  const count = signals.length;
  advance(REPLY_INTENT_MAX_MS);
  expect(signals).toHaveLength(count);
});

test("an Agent announces at most four sends at once; a freed place is usable again", () => {
  const { subject, signals } = tracker();
  for (let i = 1; i <= REPLY_INTENT_MAX_LIVE_PER_AGENT + 1; i++) subject.observe(send(`c${i}`));
  expect(signals.map((signal) => signal.callId)).toEqual(["c1", "c2", "c3", "c4"]);
  subject.observe(end("c5"));
  expect(signals).toHaveLength(4);
  subject.observe(end("c1"));
  subject.observe(send("c6"));
  expect(signals.at(-1)).toEqual({ phase: "start", callId: "c6", target: "#general" });
});

test("a call id or a target the wire cannot carry is not announced", () => {
  const { subject, signals } = tracker();
  subject.observe(send("c".repeat(129)));
  subject.observe(send("c1", `coforge message send --target '#${"a".repeat(200)}' --content hi`));
  expect(signals).toEqual([]);
});

test("a failing sink never reaches the event stream", () => {
  const { subject } = tracker(() => {
    throw new Error("publish failed");
  });
  expect(() => subject.observe(send("c1"))).not.toThrow();
  expect(() => subject.observe(end("c1"))).not.toThrow();
});

const early = (id: string, target = "#general") =>
  ({ type: "reply-intent", id, target }) satisfies AgentRuntimeEvent;

test("a target known while the call is still streaming starts the announcement at once, as early", () => {
  const { subject, signals, advance } = tracker();
  subject.observe(early("c1", "#general:ab12cd34"));
  expect(signals).toEqual([
    { phase: "start", callId: "c1", target: "#general:ab12cd34", early: true },
  ]);
  // The repeats carry the same target and flag.
  advance(REPLY_INTENT_REFRESH_MS);
  expect(signals.at(-1)).toEqual({
    phase: "start",
    callId: "c1",
    target: "#general:ab12cd34",
    early: true,
  });
});

test("the finished call does not restart an announcement that began early", () => {
  const { subject, signals, liveIntervals } = tracker();
  subject.observe(early("c1"));
  subject.observe(send("c1"));
  expect(signals).toHaveLength(1);
  expect(liveIntervals()).toBe(1);
  subject.observe(end("c1"));
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
  expect(liveIntervals()).toBe(0);
});

test("a call whose target was not known early is announced, not early, when it finishes", () => {
  const { subject, signals } = tracker();
  subject.observe(send("c1"));
  subject.observe(early("c1"));
  expect(signals).toEqual([{ phase: "start", callId: "c1", target: "#general" }]);
  expect(signals[0]).not.toHaveProperty("early");
});

test("an early announcement ends with its call, its turn or its launch, and counts toward the limit", () => {
  const { subject, signals, liveIntervals } = tracker();
  for (let i = 1; i <= REPLY_INTENT_MAX_LIVE_PER_AGENT + 1; i++) subject.observe(early(`c${i}`));
  expect(signals.map((signal) => signal.callId)).toEqual(["c1", "c2", "c3", "c4"]);
  subject.observe(end("c1"));
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
  subject.observe({ type: "completed", status: "completed" });
  expect(signals.filter((signal) => signal.phase === "end").map((s) => s.callId)).toEqual([
    "c1",
    "c2",
    "c3",
    "c4",
  ]);
  expect(liveIntervals()).toBe(0);
  subject.observe(early("c6"));
  subject.dispose();
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c6", target: "#general" });
  subject.observe(early("c7"));
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c6", target: "#general" });
});

test("an early announcement is held to the same limits as a started one", () => {
  const { subject, signals, advance } = tracker();
  subject.observe(early("c".repeat(129)));
  expect(signals).toEqual([]);
  subject.observe(early("c1"));
  advance(REPLY_INTENT_MAX_MS);
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
});

test("a finished call whose real send has no target ends the early announcement", () => {
  const { subject, signals, liveIntervals } = tracker();
  subject.observe(early("c1"));
  subject.observe(send("c1", "coforge message send --help"));
  expect(signals.map((signal) => signal.phase)).toEqual(["start", "end"]);
  expect(signals.at(-1)).toEqual({ phase: "end", callId: "c1", target: "#general" });
  expect(liveIntervals()).toBe(0);
  // The finished call is no send, so nothing restarts it.
  subject.observe(end("c1"));
  expect(signals).toHaveLength(2);
});

test("a finished call whose real target differs ends the early one and starts the real one", () => {
  const { subject, signals, advance } = tracker();
  subject.observe(early("c1", "#general"));
  subject.observe(
    send("c1", "coforge message send --target '#general' --target '#random' --content hi"),
  );
  expect(signals).toEqual([
    { phase: "start", callId: "c1", target: "#general", early: true },
    { phase: "end", callId: "c1", target: "#general" },
    { phase: "start", callId: "c1", target: "#random" },
  ]);
  // The repeats carry the real target.
  advance(REPLY_INTENT_REFRESH_MS);
  expect(signals.at(-1)).toEqual({ phase: "start", callId: "c1", target: "#random" });
});

test("the model abandoning an early call at a message boundary ends it, unless the call started", () => {
  const { subject, signals, liveIntervals } = tracker();
  subject.observe(early("c1"));
  subject.observe(early("c2"));
  subject.observe(send("c2"));
  subject.observe({ type: "reply-intent-retracted", id: "c1" });
  subject.observe({ type: "reply-intent-retracted", id: "c2" });
  subject.observe({ type: "reply-intent-retracted", id: "unknown" });
  expect(signals.filter((signal) => signal.phase === "end")).toEqual([
    { phase: "end", callId: "c1", target: "#general" },
  ]);
  // The started call is still live until its own end.
  expect(liveIntervals()).toBe(1);
  subject.observe(end("c2"));
  expect(liveIntervals()).toBe(0);
});
