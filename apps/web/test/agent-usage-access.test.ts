import { expect, test } from "bun:test";
import {
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";
import { AgentUsageAccess } from "#src/server/computers/agent-usage-access.server";
import { acceptAgentUsageResult } from "#src/server/centrifugo/agent-usage-result.server";
import { createDaemonRuntimeUsageScanResultMethod } from "#src/server/centrifugo/rpc-handler.server";
import type { AgentUsageTarget } from "#src/server/computers/agent-usage-scope.server";
import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";

const principal = { userId: "owner", workspaceId: "w" };
const target: AgentUsageTarget = {
  agentId: "agent-a",
  workspaceId: "w",
  computerId: "computer",
  provider: RUNTIME_PROVIDER.CODEX,
  runtimeConfigRevision: 3,
};
const reading: NonNullable<UsageReadResult["result"]> = {
  workspaceId: target.workspaceId,
  computerId: target.computerId,
  provider: target.provider,
  scanId: "scan-a",
  status: "available",
  collectedAt: "2026-11-20T03:00:00Z",
  snapshot: {
    provider: target.provider,
    credits: { hasCredits: true, unlimited: false, balance: "12.50" },
  },
};

function fixture({
  owner = true,
  computerAllowed = true,
  supported = true,
  balance = true,
  compatible = false,
} = {}) {
  const published: Uint8Array[] = [];
  const access = new AgentUsageAccess({
    resolve: async () =>
      owner
        ? { ...target, ...(compatible ? { billing: "provider-api-key" as const } : {}) }
        : undefined,
    usageOffer: async () =>
      computerAllowed
        ? { offered: true, runtime: { ownerId: balance ? "owner" : "another-owner" } as never }
        : { offered: false, runtime: undefined },
    supportedWorker: async () => (supported ? "worker-a" : undefined),
    cache: () => ({
      async read() {
        return { state: "fresh", result: reading };
      },
      async claim(_scope, id) {
        return id;
      },
      async release() {},
    }),
    async publish(_channel, bytes) {
      published.push(bytes);
    },
    requestId: () => "scan-a",
  });
  return { access, published };
}

test("read and scan both require Agent ownership and the Computer's usage authorization", async () => {
  for (const options of [{ owner: false }, { computerAllowed: false }]) {
    const { access, published } = fixture(options);
    await expect(access.read(principal, target.agentId)).rejects.toThrow();
    await expect(access.scan(principal, target.agentId)).rejects.toThrow();
    expect(published).toHaveLength(0);
  }
});

test("an old Computer offers neither a scan nor its Computer-wide reading", async () => {
  const { access, published } = fixture({ supported: false });
  expect(await access.read(principal, target.agentId)).toEqual({
    state: "fresh",
    unavailable: true,
  });
  expect(await access.scan(principal, target.agentId)).toEqual({ status: "unavailable" });
  expect(published).toHaveLength(0);
});

test("a scan binds the resolved target, and the runtime owner rule still controls balance", async () => {
  const { access, published } = fixture();
  expect(await access.scan(principal, target.agentId)).toEqual({
    status: "pending",
    scanId: "agent-usage:scan-a",
  });
  expect(decodeDaemonRuntimeUsageScanRequest(published[0]!)).toMatchObject({
    workspaceId: target.workspaceId,
    computerId: target.computerId,
    agentId: target.agentId,
    provider: target.provider,
    expectedRuntimeConfigRevision: target.runtimeConfigRevision,
  });
  expect((await access.read(principal, target.agentId)).result?.snapshot?.credits?.balance).toBe(
    "12.50",
  );
  expect(
    (await fixture({ balance: false }).access.read(principal, target.agentId)).result?.snapshot
      ?.credits,
  ).toEqual({ hasCredits: true, unlimited: false });
});

test("an Agent result needs a connection worker and the current configuration", async () => {
  const response = {
    protocolMajor: 1,
    requestId: reading.scanId,
    workspaceId: target.workspaceId,
    computerId: target.computerId,
    provider: target.provider,
    agentId: target.agentId,
    effectiveRuntimeConfigRevision: target.runtimeConfigRevision,
    accepted: true,
    status: "available",
  };
  const metadata = { principal: { ...principal, computerId: target.computerId } };
  const completed: string[] = [];
  const ports = {
    target: async (scope: { runtimeConfigRevision?: number }) =>
      scope.runtimeConfigRevision === target.runtimeConfigRevision ? target : undefined,
    cache: () => ({
      async complete(scope: { workerInstanceId: string }) {
        completed.push(scope.workerInstanceId);
        return true;
      },
    }),
  };
  expect(await acceptAgentUsageResult(response, metadata, reading, ports)).toMatchObject({
    code: 403,
  });
  const activeWorker = { principal: { ...metadata.principal, workerInstanceId: "worker-a" } };
  expect(
    await acceptAgentUsageResult(
      { ...response, effectiveRuntimeConfigRevision: 2 },
      activeWorker,
      reading,
      ports,
    ),
  ).toMatchObject({ code: 409 });
  expect(completed).toEqual([]);
  expect(await acceptAgentUsageResult(response, activeWorker, reading, ports)).toBeInstanceOf(
    Uint8Array,
  );
  expect(completed).toEqual(["worker-a"]);
});

test("a pre-capability worker cannot write an Agent scan's unscoped reply into the Computer cache", async () => {
  const put: string[] = [];
  const method = createDaemonRuntimeUsageScanResultMethod({
    async putResult(record) {
      put.push(record.scanId);
    },
    async releaseScan() {
      throw new Error("an Agent scan must not clear the Computer's pending request");
    },
  });
  const metadata = { principal: { ...principal, computerId: target.computerId } };
  const response = {
    protocolMajor: 1,
    workspaceId: target.workspaceId,
    computerId: target.computerId,
    provider: target.provider,
    status: "available",
    accepted: true,
    snapshotJson: new TextEncoder().encode(JSON.stringify(reading.snapshot)),
  };
  const { access } = fixture();
  const scan = await access.scan(principal, target.agentId);
  if (scan.status !== "pending") throw new Error("expected a pending Agent scan");
  expect(
    await method(
      encodeDaemonRuntimeUsageScanResponse({ ...response, requestId: scan.scanId }),
      metadata,
    ),
  ).toMatchObject({ code: 400 });
  expect(put).toEqual([]);
  expect(
    await method(
      encodeDaemonRuntimeUsageScanResponse({ ...response, requestId: "computer-scan" }),
      metadata,
    ),
  ).toBeInstanceOf(Uint8Array);
  expect(put).toEqual(["computer-scan"]);
});

test("a compatible Codex Agent reports provider billing without scanning subscription usage", async () => {
  const { access, published } = fixture({ compatible: true });
  expect(await access.read(principal, target.agentId)).toEqual({
    state: "fresh",
    billing: "provider-api-key",
    target: { computerId: target.computerId, runtimeConfigRevision: target.runtimeConfigRevision },
  });
  expect(await access.scan(principal, target.agentId)).toEqual({ status: "unavailable" });
  expect(published).toHaveLength(0);
});
