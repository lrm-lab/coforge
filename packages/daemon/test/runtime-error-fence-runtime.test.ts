import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { ackGate, createDeliveryQueueHarness } from "./fixtures/delivery-queue";

/** The runtime-level companion to `runtime-error-fence-transient.test.ts`: the same three
 * transient classes, driven through a whole DaemonRuntime, so the observable claim is the one a
 * person would make — the Agent stayed online and its delivery waited out the backoff (task #726). */

const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: mkdtempSync(join(tmpdir(), "coforge-fence-runtime-")),
};

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

afterEach(() => jest.useRealTimers());

test.each([
  ["an unreachable provider", "connect ECONNRESET"],
  ["a provider server error", "502 Bad Gateway"],
  ["a rate limit", "429 Too Many Requests"],
] as const)(
  "three identical failures from %s never fence the Agent: it stays online and keeps the delivery held until the backoff lifts (%s)",
  async (_kind, message) => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "coforge-fence-runtime-state-"));
    const acks = ackGate(1);
    const { runtime, fake, deliver, statuses, rejections } = await createDeliveryQueueHarness({
      connection,
      config,
      provider: "pi",
      acks,
      stateDirectory,
    });
    jest.useFakeTimers();
    try {
      // What the fingerprint fence would otherwise treat as a repeating failure: these three
      // lift on their own, so the Daemon keeps retrying instead of going offline.
      for (let attempt = 0; attempt < 3; attempt++) fake.emit({ type: "error", message });
      fake.emit({ type: "completed", status: "failed" });

      // Still running: nothing reported the Agent inactive and its process was not ended.
      expect(statuses.map((status) => status.status)).not.toContain("inactive");

      // The next delivery is held by the backoff — acknowledged, not rejected, not sent.
      await deliver(1);
      await acks.done;
      expect(rejections).toEqual([]);
      expect(fake.notices).toEqual([]);

      // Its delay elapses and the delivery reaches the still-online Agent.
      jest.advanceTimersByTime(60_000);
      await fake.waitForNotices(1);
      expect(fake.notices).toHaveLength(1);
      expect(statuses.map((status) => status.status)).not.toContain("inactive");
    } finally {
      await runtime.stop();
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  },
);
