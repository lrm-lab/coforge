import { afterEach, expect, test } from "bun:test";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { WakeRecycle } from "#src/daemon-runtime/wake-recycle";
import type { AgentInputQueue } from "#src/daemon-runtime/runtime-launch-intent";

const MINUTE = 60_000;
const ENV_KEYS = ["COFORGE_WAKE_RECYCLE", "COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, Bun.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
});

function provider(gap: number | undefined): CodeAgentProvider {
  return {
    provider: "codex",
    ...(gap !== undefined ? { idleRecycleMinColdGapMs: gap } : {}),
    async readSessionResumeFacts() {
      return { lastActivityAtMs: Date.now() - 31 * MINUTE, lastContextTokens: 200_000 };
    },
    async readRecycleBriefing() {
      return "carried over";
    },
  } as unknown as CodeAgentProvider;
}

async function plan(gap: number | undefined) {
  delete Bun.env.COFORGE_WAKE_RECYCLE;
  delete Bun.env.COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS;
  const queue: AgentInputQueue = { items: [], closed: false };
  const recycle = new WakeRecycle({
    provider: () => provider(gap),
    inputQueue: () => queue,
    hasQueuedDeliveries: () => false,
  });
  const decision = await recycle.plan({
    agentId: "agent-a",
    provider: "codex",
    sessionId: "thread-1",
    sessionMode: "resume",
    hasResumePrompt: false,
    memoryAgent: false,
    agentWorkspaceDirectory: "/tmp/coforge-t247-no-workspace",
  });
  return { decision, queue };
}

test("a wake uses the provider cold gap when the environment does not set one", async () => {
  const recycled = await plan(30 * MINUTE);
  expect(recycled.decision?.activityText).toContain("idle 31m");
  const first = recycled.queue.items[0];
  expect(first?.kind).toBe("prompt");
  if (first?.kind === "prompt") expect(first.text).toContain("carried over");
  const kept = await plan(undefined);
  expect(kept.decision).toBeUndefined();
  expect(kept.queue.items).toEqual([]);
});
