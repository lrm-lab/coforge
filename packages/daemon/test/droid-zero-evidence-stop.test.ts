import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { ackGate, createDeliveryGateHarness } from "./fixtures/delivery-gate";

/** Droid's ACP server can close a turn it never spoke in: the session reports `end_turn` with no
 * update at all, and an ACP session clears its own live turn before emitting `completed`. This
 * drives that shape through a whole DaemonRuntime — delivery, opened turn, completion — which is
 * the claim a person makes about s144's test Agent. The cap itself is pinned at the ledger in
 * `turn-evidence-empty-turn.test.ts`, because a single launch holds the next delivery instead of
 * opening a second empty turn. */

const connection: DaemonConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: mkdtempSync(join(tmpdir(), "coforge-zero-evidence-")),
};

const config: AgentRuntimeConfig = {
  provider: "droid",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a Droid turn that closes with no update becomes the zero-evidence Activity", async () => {
  const activities: AgentActivity[] = [];
  const { runtime, statuses, deliver } = await createDeliveryGateHarness({
    connection,
    config,
    provider: "droid",
    acks: ackGate(0),
    liveTurn: false,
    stateDirectory: mkdtempSync(join(tmpdir(), "coforge-zero-evidence-state-")),
    onActivity: (activity) => activities.push(activity),
  });
  try {
    await deliver(1);
    await settle();
    const emptyTurn = activities.filter(
      (activity) => activity.runtimeError?.errorReason === "zero_evidence_turn_completed",
    );
    expect(emptyTurn).toHaveLength(1);
    expect(emptyTurn[0]?.level).toBe("error");
    expect(emptyTurn[0]?.detail).toContain("no assistant text or tool calls");
    expect(statuses.map((status) => status.status)).toEqual(["active"]);

    await deliver(2);
    await settle();
    expect(
      activities.filter(
        (activity) => activity.runtimeError?.errorReason === "zero_evidence_turn_completed",
      ),
    ).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});
