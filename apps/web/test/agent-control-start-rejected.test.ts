import { expect, test } from "bun:test";
import { startupDeadlineMs, type AgentControlResult } from "@lrm/coforge-sdk/internal";
import {
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlState,
} from "#src/server/agents/agent-control.server";
import { AgentControlReceiver } from "#src/server/agents/agent-control-receiver.server";
import { retryFailedAutomaticStart } from "#src/server/agents/agent-control-retry.server";
import { LocalAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import { TRANSIENT_FAILURE_RETRY_INTERVAL_MS } from "#src/server/agents/agent-control-types.server";
import { pendingOpStore, pendingRuntimeConfig } from "./helpers/agent-control-store";

const START = 1_800_000_000_000;
const REJECTED = "start_intent_rejected";
const claim = { workspaceId: "w", computerId: "c" };

const starting: AgentControlState = {
  version: 1,
  protocolMajor: 1,
  requestId: "r1",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi",
  epoch: 3,
  action: "start",
  phase: "starting",
  configRevision: agentControlRevision(pendingRuntimeConfig),
  launchId: "launch-1",
  controlSequence: 0,
  sessionSequence: 0,
  startedAtMs: START,
  deadlineAtMs: START + startupDeadlineMs("pi"),
};

const agentWith = (state: AgentControlState): AgentControlAgent => ({
  id: "a",
  ownerId: "owner",
  visibility: "public",
  workspaceId: "w",
  computerId: "c",
  runtimeConfig: pendingRuntimeConfig,
  state,
});

function receiverFor(state: AgentControlState) {
  const store = pendingOpStore(agentWith(state));
  const receiver = new AgentControlReceiver(
    store.store,
    new LocalAgentControlSignal(),
    {} as never,
    undefined,
    async () => {},
    { publish: () => {} } as never,
  );
  return { ...store, receiver };
}

const receipt = (patch: Partial<AgentControlResult> = {}): AgentControlResult =>
  ({
    protocolMajor: 1,
    requestId: "r1",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    epoch: 3,
    phase: "failed",
    sequence: 1,
    errorCode: REJECTED,
    ...patch,
  }) as AgentControlResult;

test("the Daemon's receipt for a refused Start fails the operation", async () => {
  const f = receiverFor(starting);
  await f.receiver.result(claim, receipt());
  expect(f.current().state).toMatchObject({
    phase: "failed",
    errorCode: REJECTED,
    failedStreak: 1,
    controlSequence: 1,
  });
});

test("a duplicate receipt for the same operation changes nothing", async () => {
  const f = receiverFor(starting);
  await f.receiver.result(claim, receipt());
  const once = structuredClone(f.current().state);
  await f.receiver.result(claim, receipt()).catch(() => {});
  expect(f.current().state).toEqual(once);
});

test("a receipt under an epoch the server has moved past is refused", async () => {
  const f = receiverFor({ ...starting, epoch: 4 });
  await expect(f.receiver.result(claim, receipt({ epoch: 3 }))).rejects.toThrow();
  expect(f.current().state).toMatchObject({ phase: "starting", epoch: 4 });
});

test("a refused Start is not retried by a message wake, however long ago it failed", () => {
  const failed = (errorCode: string): AgentControlAgent =>
    agentWith({ ...starting, phase: "failed", errorCode, failedAtMs: START, failedStreak: 1 });
  const later = START + TRANSIENT_FAILURE_RETRY_INTERVAL_MS + 1;
  expect(retryFailedAutomaticStart(failed(REJECTED), later)).toBe(false);
  expect(retryFailedAutomaticStart(failed("launch_failed"), later)).toBe(true);
});
