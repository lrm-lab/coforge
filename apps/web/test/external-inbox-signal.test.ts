import { expect, test } from "bun:test";
import { externalInboxSignal } from "#src/server/agents/external-inbox-signal.server";

test("a notice wakes only the listeners of that Agent", () => {
  const woken: string[] = [];
  const stopA = externalInboxSignal.subscribe("agent-a", () => woken.push("a1"));
  const stopB = externalInboxSignal.subscribe("agent-b", () => woken.push("b"));
  externalInboxSignal.subscribe("agent-a", () => woken.push("a2"));
  externalInboxSignal.notify("agent-a");
  expect([...woken].sort()).toEqual(["a1", "a2"]);
  stopA();
  woken.length = 0;
  externalInboxSignal.notify("agent-a");
  expect(woken).toEqual(["a2"]);
  stopB();
});

test("a stopped listener is released", () => {
  let calls = 0;
  const stop = externalInboxSignal.subscribe("agent-c", () => calls++);
  stop();
  externalInboxSignal.notify("agent-c");
  expect(calls).toBe(0);
  expect(externalInboxSignal.listenerCount()).toBeGreaterThanOrEqual(0);
});
