import { describe, expect, test } from "bun:test";
import { captureDaemonLogs } from "./log-capture";
import type { RuntimeAuthProvider, RuntimeAuthStatus } from "@lrm/coforge-anvil";

import {
  RuntimeAuthStatusCollector,
  type RuntimeAuthCollection,
} from "#src/code-agent/runtime-auth-status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function subject(options: {
  installed?: readonly string[];
  read?: (provider: RuntimeAuthProvider) => Promise<RuntimeAuthStatus>;
  timeoutMs?: number;
}) {
  const reports: RuntimeAuthCollection[] = [];
  const reads: string[] = [];
  let now = 1_000;
  const collector = new RuntimeAuthStatusCollector({
    installedProviders: async () =>
      options.installed ?? ["claude-code", "codex", "kiro", "command-code"],
    readStatus: (provider) => {
      reads.push(provider);
      return options.read?.(provider) ?? Promise.resolve({ provider, state: "logged_out" });
    },
    report: async (report) => {
      reports.push(report);
    },
    now: () => (now += 1),
    timeoutMs: options.timeoutMs,
  });
  return { collector, reports, reads };
}

describe("collecting the runtimes' login status", () => {
  test("reads each installed runtime and reports them together, sanitized", async () => {
    const { collector, reports } = subject({
      read: async (provider) =>
        provider === "codex"
          ? {
              provider,
              state: "logged_in",
              account: { maskedLabel: "frank@example.com", planLabel: "pro" },
            }
          : { provider, state: "logged_out" },
    });
    await collector.refresh();
    expect(reports).toEqual([
      {
        collectedAtMs: expect.any(Number),
        runtimes: [
          { provider: "claude-code", state: "logged_out" },
          // An unmasked address never leaves the Computer.
          { provider: "codex", state: "logged_in", account: { planLabel: "pro" } },
          { provider: "kiro", state: "logged_out" },
          { provider: "command-code", state: "logged_out" },
        ],
      },
    ]);
  });

  test("a runtime the inventory did not find is not installed, and is not asked", async () => {
    const { collector, reports, reads } = subject({ installed: ["codex"] });
    await collector.refresh();
    expect(reads).toEqual(["codex"]);
    expect(reports[0]!.runtimes).toEqual([
      { provider: "claude-code", state: "unavailable", unavailableReason: "not_installed" },
      { provider: "codex", state: "logged_out" },
      { provider: "kiro", state: "unavailable", unavailableReason: "not_installed" },
      { provider: "command-code", state: "unavailable", unavailableReason: "not_installed" },
    ]);
  });

  test("a read that fails, has no adapter, or outlasts its deadline is unknown", async () => {
    const { collector, reports } = subject({
      timeoutMs: 20,
      read: (provider) =>
        provider === "claude-code"
          ? Promise.reject(new Error("Claude Code runtime auth adapter is not registered"))
          : new Promise(() => {}),
    });
    await collector.refresh();
    expect(reports[0]!.runtimes).toEqual([
      { provider: "claude-code", state: "unknown" },
      { provider: "codex", state: "unknown" },
      { provider: "kiro", state: "unknown" },
      { provider: "command-code", state: "unknown" },
    ]);
  });

  test("one collection runs at a time; triggers during it make exactly one more afterwards", async () => {
    const gate = deferred<RuntimeAuthStatus>();
    let first = true;
    const { collector, reports } = subject({
      installed: ["codex"],
      read: (provider) => {
        if (!first) return Promise.resolve({ provider, state: "logged_in" });
        first = false;
        return gate.promise;
      },
    });
    const running = collector.refresh();
    const again = [collector.refresh(), collector.refresh(), collector.refresh()];
    gate.resolve({ provider: "codex", state: "logged_out" });
    await Promise.all([running, ...again]);
    expect(
      reports.map((report) => report.runtimes.find((status) => status.provider === "codex")?.state),
    ).toEqual(["logged_out", "logged_in"]);
  });

  test("a report that fails is not an error for whoever asked", async () => {
    const collector = new RuntimeAuthStatusCollector({
      installedProviders: async () => [],
      readStatus: async (provider) => ({ provider, state: "unknown" }),
      report: async () => {
        throw new Error("server does not know this method");
      },
    });
    await expect(collector.refresh()).resolves.toBeUndefined();
  });
});

test("read and report failures are visible at info without credentials or raw errors", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const collector = new RuntimeAuthStatusCollector({
      installedProviders: async () => ["codex"],
      readStatus: async () => {
        throw new Error("spawn ENOENT token=private-read");
      },
      report: async () => {
        throw new Error("refused Bearer private-report");
      },
    });
    await collector.refresh();
  });
  expect(records).toHaveLength(2);
  expect(records.map((record) => record.level)).toEqual(["info", "info"]);
  expect(records[0]!.properties).toEqual({
    provider: "codex",
    detail: "spawn ENOENT token=[REDACTED]",
  });
  expect(records[1]!.properties).toEqual({ detail: "refused Bearer [REDACTED]" });
});
