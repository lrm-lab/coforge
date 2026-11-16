import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionMemoryPorts } from "../src/daemon-runtime/session-memory-hooks";
import type { AgentInputQueue } from "../src/daemon-runtime/runtime-launch-intent";

test("session memory recalls the original task before a long local memory is prepended", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-platform-recall-"));
  try {
    const directory = join(root, "workspace", "agents", "agent");
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "MEMORY.md"), "Unrelated local history. ".repeat(300));
    const input: AgentInputQueue = {
      closed: false,
      items: [
        {
          kind: "prompt",
          text: "Fix the release pipeline",
          completion: { resolve() {}, reject() {} },
        },
      ],
    };
    const calls: unknown[] = [];
    const ports = sessionMemoryPorts(
      () => ({
        connection: { workspaceRoot: root, workspaceId: "workspace" },
        inputDrain: { get: () => input },
        session: () => undefined,
      }),
      () => ({
        agentMemory: async (command: unknown, key: string) => {
          expect(key).toBe("test-only-agent-key");
          calls.push(command);
          return { enabled: true, entries: [] };
        },
      }),
    );
    expect(
      await ports.attachSessionMemory("agent", {
        agentApiKey: "test-only-agent-key",
        identity: { features: { platformMemory: true } },
      }),
    ).toBe(true);
    expect(calls).toEqual([{ operation: "search", query: "Fix the release pipeline" }]);
    const item = input.items[0];
    expect(item?.kind).toBe("prompt");
    if (item?.kind === "prompt") {
      expect(item.text).toContain("Unrelated local history.");
      expect(item.text.endsWith("Fix the release pipeline")).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
