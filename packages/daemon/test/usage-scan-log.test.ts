import { expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import type { UsageSnapshot } from "@lrm/coforge-anvil";
import { captureDaemonLogs } from "./log-capture";
import { scanUsage, type UsageScanPorts } from "#src/daemon-runtime/runtime-agent-flows";

const snapshot: UsageSnapshot = {
  provider: "claude-code",
  primary: { status: "ok", windowDurationMinutes: 300, resetsAt: "2099-09-04T03:00:00.000Z" },
};

function ports(overrides: Partial<UsageScanPorts> = {}): UsageScanPorts {
  return {
    assertRunning: () => {},
    workspaceRoot: "/workspace",
    createProvider: () => ({ readUsage: async () => snapshot }),
    observedUsage: () => undefined,
    ...overrides,
  };
}

const record = (records: readonly LogRecord[]) =>
  records.find((entry) => entry.properties.event === "agent.runtime.usage_scan")!;

test("a successful scan logs the runtime, who asked, the status and the duration", async () => {
  const { records } = await captureDaemonLogs(async () => {
    expect((await scanUsage(ports(), "claude-code")).status).toBe("available");
  });
  expect(record(records).properties).toEqual({
    event: "agent.runtime.usage_scan",
    provider: "claude-code",
    status: "available",
    duration_ms: expect.any(Number),
  });
});

test("a rate-limited read logs the error's class, status and retry-after with a redacted message", async () => {
  const failure = Object.assign(new Error("HTTP 429 too many requests token=private"), {
    status: 429,
    headers: { "retry-after": "42" },
  });
  const { records } = await captureDaemonLogs(async () => {
    expect(
      await scanUsage(
        ports({
          createProvider: () => ({
            readUsage: async () => {
              throw failure;
            },
          }),
        }),
        "claude-code",
      ),
    ).toMatchObject({ status: "error" });
  });
  expect(record(records).properties).toEqual({
    event: "agent.runtime.usage_scan",
    provider: "claude-code",
    status: "error",
    duration_ms: expect.any(Number),
    error_code: "Error",
    http_status: 429,
    retry_after: "42",
    message: "HTTP 429 too many requests token=[REDACTED]",
  });
});

test("a runtime with no reader is logged as unsupported", async () => {
  const { records } = await captureDaemonLogs(async () => {
    expect(await scanUsage(ports({ createProvider: () => ({}) }), "claude-code")).toMatchObject({
      status: "unsupported",
    });
  });
  expect(record(records).properties).toEqual({
    event: "agent.runtime.usage_scan",
    provider: "claude-code",
    status: "unsupported",
    duration_ms: expect.any(Number),
  });
});
