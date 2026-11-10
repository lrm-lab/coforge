import { expect, test } from "bun:test";
import { AgentLifecycle } from "#src/daemon-runtime/agent-lifecycle";

test("each listener hears the events it follows, and one that throws does not keep the others", () => {
  const lifecycle = new AgentLifecycle();
  const heard: string[] = [];
  lifecycle.subscribe({
    stopped: () => {
      throw new Error("a listener failed");
    },
  });
  lifecycle.subscribe({
    stopped: (agentId) => void heard.push(`stopped ${agentId}`),
    processClosed: (agentId) => void heard.push(`closed ${agentId}`),
  });
  lifecycle.stopped("a");
  lifecycle.processClosed("b");
  expect(heard).toEqual(["stopped a", "closed b"]);
});

test("an unsubscribed listener hears nothing", () => {
  const lifecycle = new AgentLifecycle();
  const heard: string[] = [];
  const unsubscribe = lifecycle.subscribe({ stopped: (agentId) => void heard.push(agentId) });
  unsubscribe();
  lifecycle.stopped("a");
  expect(heard).toEqual([]);
});
