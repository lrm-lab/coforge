import { expect, test } from "bun:test";
import { agentSessionIsLive } from "#src/agent-proxy-session-admission";

/** The rule the proxy admits on: a running session, or a launch admitted and not yet ended or
 * stopping. Anything else makes the Agent's token answer 409 until its next session. */
function state(input: { running?: boolean; launch?: { stopping: boolean } | undefined }) {
  return {
    isRunning: () => input.running === true,
    launch: () => input.launch,
  };
}

test("a running session answers", () => {
  expect(agentSessionIsLive(state({ running: true }), "agent-a")).toBe(true);
});

test("a launch still spinning up answers before any process is registered", () => {
  expect(agentSessionIsLive(state({ launch: { stopping: false } }), "agent-a")).toBe(true);
});

test("a launch whose process already exited does not answer", () => {
  expect(agentSessionIsLive(state({}), "agent-a")).toBe(false);
});

test("a launch that began stopping does not answer", () => {
  expect(agentSessionIsLive(state({ launch: { stopping: true } }), "agent-a")).toBe(false);
});

test("a process still registered while its Stop runs answers until the token is revoked", () => {
  expect(agentSessionIsLive(state({ running: true, launch: { stopping: true } }), "agent-a")).toBe(
    true,
  );
});
