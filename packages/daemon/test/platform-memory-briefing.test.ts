import { expect, test } from "bun:test";
import { attachPlatformMemoryBriefing } from "../src/agent-runtime/platform-memory-briefing";
import type { AgentInputQueue } from "../src/daemon-runtime/runtime-launch-intent";
function queue(): AgentInputQueue {
  return {
    closed: false,
    items: [
      {
        kind: "prompt",
        text: "Upgrade an old cloud computer",
        completion: { resolve() {}, reject() {} },
      },
    ],
  };
}
test("a fresh task receives bounded recalled reference before its original prompt", async () => {
  const input = queue();
  await attachPlatformMemoryBriefing(input, async (command) => {
    expect(command).toEqual({ operation: "search", query: "Upgrade an old cloud computer" });
    return {
      enabled: true,
      entries: [
        {
          id: "memory",
          revision: 2,
          scope: "team",
          title: "Upgrade prerequisite",
          content: "Check the runtime activation script exists",
        },
      ],
    };
  });
  expect(input.items[0]?.kind).toBe("memory");
  expect(input.items[1]?.kind).toBe("prompt");
});
test("a memory outage or a queue closed during recall leaves the original task intact", async () => {
  const input = queue();
  await attachPlatformMemoryBriefing(input, async () => {
    throw new Error("offline");
  });
  expect(input.items).toHaveLength(1);
  await attachPlatformMemoryBriefing(input, async () => {
    input.closed = true;
    return { enabled: true, entries: [{ title: "x", content: "y" }] };
  });
  expect(input.items).toHaveLength(1);
});
