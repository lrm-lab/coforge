import { expect, test } from "bun:test";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { subscribeProviderScans } from "#src/daemon-runtime/provider-scan-handlers";

test("a usage answer waits for authentication to be collected and reported, even without usage", async () => {
  let receive!: Parameters<NonNullable<DaemonConnectionClient["onUsageScan"]>>[0];
  const order: string[] = [];
  const reported = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const transport = {
    onUsageScan: (handler: typeof receive) => {
      receive = handler;
      return () => {};
    },
    sendUsageScanResult: async () => {
      order.push("usage answered");
    },
  } as unknown as DaemonConnectionClient;
  subscribeProviderScans(transport, {
    connection: { workspaceId: "workspace-a", computerId: "computer-a" },
    runtime: {
      scanUsage: async () => ({
        protocolMajor: 1,
        requestId: "scan-a",
        accepted: true,
        status: "unknown",
      }),
    },
    currentTransport: () => transport,
    isStopping: () => false,
    runtimeAuth: {
      usageScanned: async (provider, status) => {
        expect(provider).toBe("kiro");
        expect(status).toBe("unknown");
        order.push("auth started");
        entered.resolve();
        await reported.promise;
        order.push("auth reported");
      },
    },
    inventory: { refreshModels: async () => {} },
  });
  const completion = receive({
    protocolMajor: 1,
    requestId: "scan-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    provider: "kiro",
  });
  await entered.promise;
  expect(order).toEqual(["auth started"]);
  reported.resolve();
  await completion;
  expect(order).toEqual(["auth started", "auth reported", "usage answered"]);
});

test("an auth-report failure answers error rather than a successful usage-only refresh", async () => {
  let receive!: Parameters<NonNullable<DaemonConnectionClient["onUsageScan"]>>[0];
  const results: unknown[] = [];
  const transport = {
    onUsageScan: (handler: typeof receive) => {
      receive = handler;
      return () => {};
    },
    sendUsageScanResult: async (result: unknown) => {
      results.push(result);
    },
  } as unknown as DaemonConnectionClient;
  subscribeProviderScans(transport, {
    connection: { workspaceId: "workspace-a", computerId: "computer-a" },
    runtime: {
      scanUsage: async () => ({
        protocolMajor: 1,
        requestId: "scan-a",
        accepted: true,
        status: "available",
        snapshotJson: new Uint8Array([1]),
      }),
    },
    currentTransport: () => transport,
    isStopping: () => false,
    runtimeAuth: {
      usageScanned: async () => {
        throw new Error("503 secret upstream detail");
      },
    },
    inventory: { refreshModels: async () => {} },
  });
  await receive({
    protocolMajor: 1,
    requestId: "scan-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    provider: "kiro",
  });
  expect(results).toEqual([
    {
      protocolMajor: 1,
      requestId: "scan-a",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      provider: "kiro",
      accepted: false,
      status: "error",
      message: "Runtime login status could not be refreshed",
    },
  ]);
});
