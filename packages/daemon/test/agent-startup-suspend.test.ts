import { expect, test } from "bun:test";
import { AgentStartup, STARTUP_SUSPEND_SLACK_MS } from "#src/agent-runtime/agent-startup";

const TIMEOUT_MS = 20;

test("a startup window that expires in time abandons the launch", async () => {
  const expired = Promise.withResolvers<void>();
  let clock = 0;
  const startup = new AgentStartup(() => expired.resolve(), {
    timeoutMs: TIMEOUT_MS,
    now: () => clock,
  });
  clock += TIMEOUT_MS;
  await expired.promise;
  expect(startup.fail(new Error("timed out"))).toBe(true);
});

test("a window that fires long after its time restarts instead of abandoning a live process", async () => {
  const expired = Promise.withResolvers<void>();
  let fired = 0;
  let clock = 0;
  const startup = new AgentStartup(
    () => {
      fired += 1;
      expired.resolve();
    },
    { timeoutMs: TIMEOUT_MS, now: () => clock },
  );
  // The Computer slept through the window: the clock jumped while the loop was frozen.
  clock += TIMEOUT_MS + STARTUP_SUSPEND_SLACK_MS + 1;
  await Bun.sleep(TIMEOUT_MS * 2);
  expect(fired).toBe(0);
  expect(startup.waiting).toBe(true);
  // The restarted window judges the process as usual.
  clock += TIMEOUT_MS;
  await expired.promise;
  expect(fired).toBe(1);
});

test("an event after the Computer woke still closes the restarted window", async () => {
  let clock = 0;
  const startup = new AgentStartup(() => {}, { timeoutMs: TIMEOUT_MS, now: () => clock });
  clock += TIMEOUT_MS + STARTUP_SUSPEND_SLACK_MS + 1;
  await Bun.sleep(TIMEOUT_MS * 2);
  startup.observe({ type: "completed", status: "ok" } as never);
  expect(startup.waiting).toBe(false);
});
