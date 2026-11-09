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
      consumeResetCredit: async () => ({ outcome: "unsupported" }),
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
      consumeResetCredit: async () => ({ outcome: "unsupported" }),
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

test("an effort read is answered only for this Computer while it is running", async () => {
  let receive!: Parameters<NonNullable<DaemonConnectionClient["onCommandCodeEffortRead"]>>[0];
  const seen: string[] = [];
  let stopping = false;
  const transport = {
    onCommandCodeEffortRead: (handler: typeof receive) => {
      receive = handler;
      return () => {};
    },
  } as unknown as DaemonConnectionClient;
  subscribeProviderScans(transport, {
    connection: { workspaceId: "workspace-a", computerId: "computer-a" },
    runtime: {
      consumeResetCredit: async () => ({ outcome: "unsupported" }),
      scanUsage: async () => ({
        protocolMajor: 1,
        requestId: "unused",
        accepted: false,
        status: "unknown",
      }),
    },
    currentTransport: () => transport,
    isStopping: () => stopping,
    runtimeAuth: { usageScanned: async () => undefined },
    inventory: {
      refreshModels: async () => undefined,
      readCommandCodeEfforts: async (request) => {
        seen.push(request.modelId);
      },
    },
  });
  const request = {
    protocolMajor: 1,
    requestId: "effort-1",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    modelId: "native-model",
  };
  await receive({ ...request, computerId: "computer-b", modelId: "other-computer" });
  stopping = true;
  await receive({ ...request, modelId: "while-stopping" });
  stopping = false;
  await receive(request);
  expect(seen).toEqual(["native-model"]);
});

test("a reset credit request is answered with the outcome and the fresh usage, only for this Computer while running", async () => {
  let receive!: Parameters<NonNullable<DaemonConnectionClient["onResetCreditConsume"]>>[0];
  const asked: Array<{ provider: string; idempotencyKey: string }> = [];
  const answers: unknown[] = [];
  let stopping = false;
  const transport = {
    onResetCreditConsume: (handler: typeof receive) => {
      receive = handler;
      return () => {};
    },
    sendResetCreditConsumeResult: async (answer: unknown) => {
      answers.push(answer);
    },
  } as unknown as DaemonConnectionClient;
  subscribeProviderScans(transport, {
    connection: { workspaceId: "workspace-a", computerId: "computer-a" },
    runtime: {
      scanUsage: async () => {
        throw new Error("a reset credit attempt reads usage through consumeResetCredit");
      },
      consumeResetCredit: async (provider, idempotencyKey) => {
        asked.push({ provider, idempotencyKey });
        return { outcome: "reset", snapshotJson: new Uint8Array([1, 2]) };
      },
    },
    currentTransport: () => transport,
    isStopping: () => stopping,
    runtimeAuth: { usageScanned: async () => undefined },
    inventory: { refreshModels: async () => undefined },
  });
  const request = {
    protocolMajor: 1,
    requestId: "reset-1",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    provider: "codex" as const,
    idempotencyKey: "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59",
  };
  await receive({ ...request, computerId: "computer-b" });
  stopping = true;
  await receive(request);
  stopping = false;
  await receive(request);
  expect(asked).toEqual([{ provider: "codex", idempotencyKey: request.idempotencyKey }]);
  expect(answers).toEqual([
    {
      protocolMajor: 1,
      requestId: "reset-1",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      provider: "codex",
      outcome: "reset",
      snapshotJson: new Uint8Array([1, 2]),
    },
  ]);
});

test("a reset credit answer that cannot be sent, or an attempt that throws, never rejects the handler", async () => {
  // The control channel calls the handler without awaiting it, so a rejection would be an
  // unhandled one, and an unhandled rejection ends the Daemon child.
  for (const failure of ["send", "attempt"] as const) {
    let receive!: Parameters<NonNullable<DaemonConnectionClient["onResetCreditConsume"]>>[0];
    const transport = {
      onResetCreditConsume: (handler: typeof receive) => {
        receive = handler;
        return () => {};
      },
      sendResetCreditConsumeResult: async () => {
        throw new Error("connection dropped during the attempt");
      },
    } as unknown as DaemonConnectionClient;
    subscribeProviderScans(transport, {
      connection: { workspaceId: "workspace-a", computerId: "computer-a" },
      runtime: {
        scanUsage: async () => ({
          protocolMajor: 1,
          requestId: "",
          accepted: false,
          status: "unknown",
        }),
        consumeResetCredit: async () => {
          if (failure === "attempt") throw new Error("runtime is gone");
          return { outcome: "reset" };
        },
      },
      currentTransport: () => transport,
      isStopping: () => false,
      runtimeAuth: { usageScanned: async () => undefined },
      inventory: { refreshModels: async () => undefined },
    });
    await receive({
      protocolMajor: 1,
      requestId: "reset-3",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      provider: "codex",
      idempotencyKey: "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59",
    });
  }
});
