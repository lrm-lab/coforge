import { describe, expect, test } from "bun:test";
import type { RuntimeAuthAdapter, RuntimeAuthProvider } from "@lrm/coforge-anvil";
import type { RuntimeAuthStatusReport } from "@lrm/coforge-sdk/internal";
import type { RuntimeMetadata } from "@lrm/coforge-sdk/internal";

import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { RuntimeAuthReporter } from "#src/daemon-runtime/runtime-auth-reporter";

const runtime = (provider: string) => ({ provider, version: "1.0.0", displayName: provider });

function subject() {
  const sent: RuntimeAuthStatusReport[] = [];
  const reads: { provider: string; workingDirectory: string }[] = [];
  let stopping = false;
  let failSend: Error | undefined;
  const makeTransport = () =>
    ({
      reportRuntimeAuthStatus: async (report: RuntimeAuthStatusReport) => {
        if (failSend) throw failSend;
        sent.push(report);
      },
    }) as unknown as DaemonConnectionClient;
  let transport = makeTransport();
  const reporter = new RuntimeAuthReporter({
    owner: { workspaceId: "workspace-a", computerId: "computer-a" },
    workingDirectory: "/workspace",
    transport: () => transport,
    isStopping: () => stopping,
    createAdapter: (provider: RuntimeAuthProvider) =>
      ({
        readStatus: async ({ workingDirectory }: { workingDirectory: string }) => {
          reads.push({ provider, workingDirectory });
          return { provider, state: "logged_out" };
        },
      }) as unknown as RuntimeAuthAdapter,
  });
  return {
    reporter,
    sent,
    reads,
    stop: () => (stopping = true),
    fail: (error: Error) => (failSend = error),
    replaceTransport: () => (transport = makeTransport()),
  };
}

describe("the Workspace runtime's login status reporter", () => {
  test("reports the inventory's providers once the inventory is known", async () => {
    const { reporter, sent, reads } = subject();
    await reporter.inventoryReported([runtime("codex"), runtime("pi")] as RuntimeMetadata[]);

    expect(reads).toEqual([{ provider: "codex", workingDirectory: "/workspace" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      protocolMajor: 1,
      workspaceId: "workspace-a",
      computerId: "computer-a",
    });
    expect(sent[0]!.requestId).not.toBe("");
    expect(sent[0]!.runtimes).toEqual([
      { provider: "claude-code", state: "unavailable", unavailableReason: "not_installed" },
      { provider: "codex", state: "logged_out" },
      { provider: "kiro", state: "unavailable", unavailableReason: "not_installed" },
      { provider: "command-code", state: "unavailable", unavailableReason: "not_installed" },
      { provider: "devin", state: "unavailable", unavailableReason: "not_installed" },
    ]);
  });

  test("a refresh before any inventory reports nothing", async () => {
    const { reporter, sent } = subject();
    await reporter.refresh();
    expect(sent).toEqual([]);
  });

  test("a refresh after the inventory reads again with a fresh request id", async () => {
    const { reporter, sent } = subject();
    await reporter.inventoryReported([runtime("codex")] as RuntimeMetadata[]);
    await reporter.refresh();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
  });

  test("every later inventory discovery re-reads authentication even with the same providers", async () => {
    const { reporter, sent } = subject();
    await reporter.inventoryReported([runtime("codex")] as RuntimeMetadata[]);

    await reporter.inventoryObserved([runtime("codex"), runtime("pi")] as RuntimeMetadata[]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.runtimes.map((entry) => entry.state)).toEqual([
      "unavailable",
      "logged_out",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);

    await reporter.inventoryObserved([
      runtime("codex"),
      runtime("claude-code"),
    ] as RuntimeMetadata[]);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.runtimes.map((entry) => entry.state)).toEqual([
      "logged_out",
      "logged_out",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  test("the first inventory seen by a later discovery reports, when the first report never resolved", async () => {
    const { reporter, sent } = subject();
    await reporter.inventoryObserved([runtime("codex")] as RuntimeMetadata[]);
    expect(sent).toHaveLength(1);
  });

  test("every answered scan of a login-capable provider waits for a new authentication report", async () => {
    const { reporter, sent } = subject();
    await reporter.inventoryReported([runtime("kiro")] as RuntimeMetadata[]);

    for (const status of ["available", "unknown", "unsupported", "error", "reauth"] as const) {
      const count = sent.length;
      await reporter.usageScanned("kiro", status);
      expect(sent).toHaveLength(count + 1);
      expect(sent.at(-1)!.runtimes).toContainEqual({ provider: "kiro", state: "logged_out" });
    }

    await reporter.usageScanned("pi", "reauth");
    expect(sent).toHaveLength(6);
  });

  test("a stopping runtime sends nothing", async () => {
    const { reporter, sent, stop } = subject();
    stop();
    await reporter.inventoryReported([runtime("codex")] as RuntimeMetadata[]);
    expect(sent).toEqual([]);
  });

  test("a report goes to the transport that is live when it is sent", async () => {
    const { reporter, sent, replaceTransport } = subject();
    await reporter.inventoryReported([runtime("codex")] as RuntimeMetadata[]);
    replaceTransport();
    await reporter.refresh();
    expect(sent).toHaveLength(2);
  });

  test("a server that refuses the report does not fail the trigger", async () => {
    const { reporter, fail } = subject();
    fail(new Error("404 unknown RPC method"));
    await expect(
      reporter.inventoryReported([runtime("codex")] as RuntimeMetadata[]),
    ).resolves.toBeUndefined();
  });
});

test("reuses an adapter across refreshes so its account lookup cache survives", async () => {
  let adapterCreations = 0;
  let whoamiCalls = 0;
  let lookupDone = false;
  const sent: RuntimeAuthStatusReport[] = [];
  const reporter = new RuntimeAuthReporter({
    owner: { workspaceId: "workspace-a", computerId: "computer-a" },
    workingDirectory: "/workspace",
    transport: () =>
      ({
        reportRuntimeAuthStatus: async (report: RuntimeAuthStatusReport) => {
          sent.push(report);
        },
      }) as unknown as DaemonConnectionClient,
    isStopping: () => false,
    createAdapter: (provider: RuntimeAuthProvider) => {
      adapterCreations += 1;
      return {
        readStatus: async () => {
          if (!lookupDone) {
            lookupDone = true;
            whoamiCalls += 1;
          }
          return { provider, state: "logged_in", account: { maskedLabel: "amy****@example.com" } };
        },
      } as unknown as RuntimeAuthAdapter;
    },
  });

  await reporter.inventoryReported([runtime("command-code")] as RuntimeMetadata[]);
  await reporter.refresh();
  expect(sent).toHaveLength(2);
  expect(adapterCreations).toBe(1);
  expect(whoamiCalls).toBe(1);
});

test("recreates adapters when a new inventory is observed", async () => {
  let adapterCreations = 0;
  const reporter = new RuntimeAuthReporter({
    owner: { workspaceId: "workspace-a", computerId: "computer-a" },
    workingDirectory: "/workspace",
    transport: () =>
      ({ reportRuntimeAuthStatus: async () => {} }) as unknown as DaemonConnectionClient,
    isStopping: () => false,
    createAdapter: (provider: RuntimeAuthProvider) => {
      adapterCreations += 1;
      return {
        readStatus: async () => ({ provider, state: "logged_out" }),
      } as unknown as RuntimeAuthAdapter;
    },
  });

  await reporter.inventoryReported([runtime("command-code")] as RuntimeMetadata[]);
  await reporter.inventoryObserved([runtime("command-code")] as RuntimeMetadata[]);
  expect(adapterCreations).toBe(2);
});

test("a usage refresh refuses to claim completion when the auth report was rejected", async () => {
  const { reporter, fail } = subject();
  await reporter.inventoryReported([runtime("kiro")] as RuntimeMetadata[]);
  fail(new Error("503 auth storage unavailable"));
  await expect(reporter.usageScanned("kiro", "available")).rejects.toThrow();
});
