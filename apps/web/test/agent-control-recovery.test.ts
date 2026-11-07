import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
} from "#src/server/agents/agent-control.server";
import { decodeAgentStartIntent } from "@lrm/coforge-sdk/internal";
import { pendingOpStore, pendingRuntimeConfig } from "./helpers/agent-control-store";

test("recover republishes a pending start unchanged, without superseding it", async () => {
  const { store, current } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: pendingRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck-start",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 9,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(pendingRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
    },
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  await control.recover(
    {
      protocolMajor: 1,
      requestId: "ready-recovery",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
    },
    "owner",
  );
  expect(sent).toHaveLength(1);
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    requestId: "stuck-start",
    controlEpoch: 9,
  });
  // recover() never supersedes: same requestId, same epoch, same phase — only republished.
  expect(current().state).toMatchObject({ requestId: "stuck-start", epoch: 9, phase: "starting" });
});

test("a launchId is minted once per operation and stays stable across a republish (recover)", async () => {
  const { store, current } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: pendingRuntimeConfig,
    state: null,
  });
  const sent: Uint8Array[] = [];
  // The daemon never answers, so the operation stays pending: `execute()`'s own single publish,
  // then two Daemon-ready `recover()` republishes of the SAME pending request. The launchId must
  // never change across any of them — no new epoch, no new mint.
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const view = await control.execute({
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "start-1",
    action: "start",
  });
  expect(view.phase).toBe("pending");
  expect(sent).toHaveLength(1);
  const mintedLaunchId = decodeAgentStartIntent(sent[0]!).launchId;
  expect(mintedLaunchId).toBeTruthy();
  expect(current().state?.launchId).toBe(mintedLaunchId);

  const recoverIntent = {
    protocolMajor: 1,
    requestId: "recover-request",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi" as const,
    model: "",
    reasoning: "",
  };
  sent.length = 0;
  await control.recover(recoverIntent, "owner");
  await control.recover(recoverIntent, "owner");
  expect(sent).toHaveLength(2);
  for (const bytes of sent) expect(decodeAgentStartIntent(bytes).launchId).toBe(mintedLaunchId);
  expect(current().state?.launchId).toBe(mintedLaunchId);
  expect(current().state?.requestId).toBe("start-1");
});
