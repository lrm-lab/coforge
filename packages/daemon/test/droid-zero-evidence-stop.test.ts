import { expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { createDeliveryGateHarness } from "./fixtures/delivery-gate";
import { until } from "./fixtures/wake-recycle-harness";
import { captureDaemonLogs } from "./log-capture";

test("five empty Droid deliveries stop the Agent and later delivery does not restart it", async () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-droid-zero-evidence-"));
  const activities: AgentActivity[] = [];
  const emptyTurns = () =>
    activities.filter(
      (activity) => activity.runtimeError?.errorReason === "zero_evidence_turn_completed",
    );
  try {
    await captureDaemonLogs(async (records) => {
      const backoffs = () =>
        records.filter((record) => record.properties.event === "agent.runtime.delivery_held");
      const { runtime, fake, deliver, acks, statuses, rejections, launches } =
        await createDeliveryGateHarness({
          connection: {
            computerId: "computer-a",
            workspaceId: "workspace-a",
            workspaceRoot: root,
          },
          provider: "droid",
          config: {
            provider: "droid",
            model: "default",
            modelProvider: "anthropic",
            reasoning: "balanced",
          },
          stateDirectory: root,
          onActivity: (activity) => activities.push(activity),
        });
      try {
        const reportedStatuses = () => statuses.map(({ status }) => status);
        expect(reportedStatuses()).toEqual(["active"]);
        expect(emptyTurns()).toHaveLength(0);
        expect(backoffs()).toHaveLength(0);
        jest.useFakeTimers();

        for (let turn = 1; turn <= 5; turn += 1) {
          await deliver(turn);
          expect(acks.acks.at(-1)).toBe(`delivery-${turn}`);
          if (turn > 1) {
            expect(fake.notices).toHaveLength(turn - 1);
            const delay = Number(backoffs().at(-1)?.properties.retry_in_ms);
            expect(delay).toBeGreaterThan(0);
            jest.advanceTimersByTime(delay);
          }
          await fake.waitForNotices(turn);
          fake.emit({ type: "completed", status: "completed" });
          if (turn < 5) {
            expect(emptyTurns()).toHaveLength(turn);
            expect(backoffs()).toHaveLength(turn);
            expect(reportedStatuses()).toEqual(["active"]);
          }
        }

        await fake.disposed;
        jest.useRealTimers();
        await until(() => runtime.runtime("agent-a") === undefined);
        expect(emptyTurns()).toHaveLength(4);
        expect(backoffs()).toHaveLength(4);
        expect(reportedStatuses().at(-1)).toBe("inactive");
        expect(
          activities.find(
            (activity) => activity.runtimeError?.errorReason === "runtime_error_fenced",
          ),
        ).toMatchObject({
          level: "error",
          detail:
            "The runtime ended 5 turns in a row without any output, so CoForge stopped restarting it. Restart the Agent to try again.",
        });

        await deliver(6);
        expect(acks.acks.at(-1)).toBe("delivery-6");
        expect(fake.notices).toHaveLength(5);
        expect(launches()).toBe(1);
        expect(rejections).toEqual([]);
        expect(reportedStatuses().at(-1)).toBe("inactive");
      } finally {
        jest.useRealTimers();
        await runtime.stop();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
