import { describe, expect, test } from "bun:test";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { unsettledWorkspaceLine } from "#src/daemon-client/workspace-report-line";

const runtime = (overrides: Partial<ManagedRuntimeIdentity> = {}): ManagedRuntimeIdentity => ({
  workspaceId: "w1",
  computerId: "c1",
  enabled: true,
  processId: 1,
  instanceId: "i",
  version: "1",
  ...overrides,
});

describe("unsettledWorkspaceLine", () => {
  test("a Workspace still starting or restarting points at status", () => {
    expect(unsettledWorkspaceLine("start", "acme", runtime({ lifecycleUnderWay: true }))).toEqual({
      line: "  acme: still starting. Run 'coforge-computer status' to follow it.",
      failed: false,
    });
    expect(
      unsettledWorkspaceLine("restart", "acme", runtime({ lifecycleUnderWay: true })).line,
    ).toBe("  acme: still restarting. Run 'coforge-computer status' to follow it.");
  });

  test("a Workspace still connecting names its latest failed attempt when there is one", () => {
    expect(
      unsettledWorkspaceLine("start", "acme", runtime({ cloudConnection: "connecting" })),
    ).toEqual({
      line: "  acme: still connecting. Run 'coforge-computer status' to follow it.",
      failed: false,
    });
    expect(
      unsettledWorkspaceLine(
        "start",
        "acme",
        runtime({ cloudConnection: "connecting", cloudConnectionError: "timeout" }),
      ).line,
    ).toBe(
      "  acme: still connecting, retrying after timeout. Run 'coforge-computer status' to follow it.",
    );
  });

  test("a Workspace that did not connect fails with why, or an unknown error", () => {
    expect(
      unsettledWorkspaceLine(
        "start",
        "acme",
        runtime({ cloudConnection: "not_connected", cloudConnectionError: "refused" }),
      ),
    ).toEqual({ line: "  acme: not connected (refused).", failed: true });
    expect(
      unsettledWorkspaceLine("restart", "acme", runtime({ cloudConnection: "not_connected" })),
    ).toEqual({ line: "  acme: not connected (unknown error).", failed: true });
  });

  test("an error with terminal control characters is made safe to print", () => {
    expect(
      unsettledWorkspaceLine(
        "start",
        "acme",
        runtime({ cloudConnection: "not_connected", cloudConnectionError: "bad\u001b[31mred" }),
      ).line,
    ).not.toContain("\u001b");
  });
});
