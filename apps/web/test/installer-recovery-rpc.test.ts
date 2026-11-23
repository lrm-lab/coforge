import { expect, test } from "bun:test";
import { installerRecoveryRpc } from "#src/server/centrifugo/installer-recovery-rpc.server";
import type { CentrifugoRpcMetadata } from "#src/server/centrifugo/rpc-types.server";

const metadata: CentrifugoRpcMetadata = {
  principal: {
    userId: "owner",
    workspaceId: "workspace",
    computerId: "computer",
    workerInstanceId: "worker",
    connectionSequence: 1,
  },
  client: "connection",
};
const claim = {
  workspaceId: "workspace",
  computerId: "computer",
  workerInstanceId: "worker",
  startedAt: 1,
  online: true,
  installerRecoveryObservation: { requestChallenge: true },
};

test("only a scoped Daemon with authenticated connection metadata can open or sample a lease", async () => {
  const calls: string[] = [];
  const store = {
    async ready() {
      calls.push("ready");
      return true;
    },
    async observe() {
      calls.push("observe");
      return undefined;
    },
    async close() {
      calls.push("close");
    },
  };
  const rpc = installerRecoveryRpc(() => store);
  for (const invalid of [
    { ...metadata, principal: { ...metadata.principal, agentId: "agent" } },
    { ...metadata, principal: { ...metadata.principal, workerInstanceId: "different" } },
    { ...metadata, principal: { ...metadata.principal, workspaceId: "elsewhere" } },
    { ...metadata, principal: { ...metadata.principal, computerId: "" } },
    { ...metadata, principal: { ...metadata.principal, connectionSequence: undefined } },
    { ...metadata, client: undefined },
  ]) {
    await rpc.ready(claim, invalid);
    await rpc.observe(claim, invalid);
    await rpc.close(claim, invalid);
  }
  expect(calls).toEqual([]);
  await rpc.ready(claim, metadata);
  await rpc.observe({ ...claim, installerRecoveryObservation: undefined }, metadata);
  await rpc.observe(
    { ...claim, installerRecoveryObservation: { requestChallenge: false } },
    metadata,
  );
  await rpc.observe(claim, metadata);
  await rpc.observe({ ...claim, online: false }, metadata);
  expect(calls).toEqual(["ready", "observe", "close"]);
});
