import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { withMemoryRecovery } from "#src/agent-runtime/session-memory-recovery";

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

test("compaction alone starts no turn; memory rides once with the next real input", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-memory-recovery-"));
  roots.push(root);
  await writeFile(join(root, "MEMORY.md"), "Domain already purchased: coforgeusercontent.com");
  const inputs: string[] = [];
  const cutoffs: (number | undefined)[] = [];
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const original: AgentSession = {
    sendMessage: async (text) => {
      inputs.push(text);
    },
    notify: async (text) => {
      inputs.push(text);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onExit: () => () => {},
    interrupt: async () => {},
    dispose: async (options) => {
      cutoffs.push(options?.cutoffAtMs);
    },
  };
  const session = withMemoryRecovery(original, root);
  expect(session).toBe(original);
  for (const listener of listeners) listener({ type: "compaction-finished" });
  expect(inputs).toEqual([]);
  await session.notify!("Which domain should preview use?");
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toContain("coforgeusercontent.com");
  expect(inputs[0]).toEndWith("Which domain should preview use?");
  const thanks = session.notify!("Thanks");
  expect(inputs[1]).toBe("Thanks");
  await thanks;
  await session.dispose({ cutoffAtMs: 1234 });
  expect(cutoffs).toEqual([1234]);
  expect(listeners.size).toBe(0);
});
