import { expect, test } from "bun:test";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  decodeAgentActivity,
  type AgentCredentialRestored,
} from "@lrm/coforge-sdk/internal";
import { CredentialRestoredActivity } from "#src/server/agents/credential-restored-activity.server";
import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";

const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
const report: AgentCredentialRestored = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: scope.workspaceId,
  agentId: "agent-1",
  reason: "user_reauth",
  releaseCause: "credentials_changed",
  restoredAtMs: 1_700_000_000_000,
};

function subject(
  options: {
    newest?: {
      detailKind: string;
      level: string;
      runtimeErrorReason?: string | null;
      occurredAtMs?: number;
    };
    visibility?: "public" | "private";
  } = {},
) {
  const rows: TrustedAgentActivity[] = [];
  const published: { channel: string; data: Uint8Array }[] = [];
  const restored = new CredentialRestoredActivity({
    agents: async () => [{ id: "agent-1", visibility: options.visibility ?? "public" }],
    newest: async () =>
      options.newest ?? {
        detailKind: "runtime_error",
        level: "error",
        runtimeErrorReason: "auth_failed",
        occurredAtMs: 1_699_999_999_000,
      },
    record: async (activities) => void rows.push(...activities),
    publish: async (channel, data) => void published.push({ channel, data }),
  });
  return { restored, rows, published };
}

test("an Agent whose newest Activity is the failure gets an idle row that supersedes it", async () => {
  const { restored, rows, published } = subject();
  await expect(restored.receive(scope, report)).resolves.toBe(true);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    agentId: "agent-1",
    computerId: "computer-1",
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.IDLE,
    level: "info",
    detail: "",
    observedAtMs: 1_700_000_000_000,
    launchId: "credential-restored:request-1",
    clientSeq: 1,
  });
  expect(published).toHaveLength(1);
  expect(decodeAgentActivity(published[0]!.data)).toMatchObject({ detailKind: "idle" });
});

test("an Agent that has moved on since is left as it is", async () => {
  const { restored, rows, published } = subject({
    newest: { detailKind: "tool_started", level: "info" },
  });
  await expect(restored.receive(scope, report)).resolves.toBe(true);
  expect(rows).toEqual([]);
  expect(published).toEqual([]);
});

test("an Agent that is not assigned to the Computer is refused", async () => {
  const { restored, rows } = subject();
  await expect(restored.receive(scope, { ...report, agentId: "agent-other" })).resolves.toBe(false);
  expect(rows).toEqual([]);
});

test("only the failure the report names is superseded: another error stays", async () => {
  const { restored, rows } = subject({
    newest: { detailKind: "runtime_error", level: "error", runtimeErrorReason: "rate_limited" },
  });
  await expect(restored.receive(scope, report)).resolves.toBe(true);
  expect(rows).toEqual([]);
});

test.each([
  ["user_model_access", "model_config_error"],
  ["BillingError", "billing_exhausted"],
] as const)("a %s report supersedes the %s failure", async (reason, errorReason) => {
  const { restored, rows } = subject({
    newest: { detailKind: "runtime_error", level: "error", runtimeErrorReason: errorReason },
  });
  await restored.receive(scope, { ...report, reason });
  expect(rows).toHaveLength(1);
});

test("the idle row is ordered by the daemon's clock, and never before the failure it ends", async () => {
  const early = subject({
    newest: {
      detailKind: "runtime_error",
      level: "error",
      runtimeErrorReason: "auth_failed",
      occurredAtMs: 1_700_000_005_000,
    },
  });
  await early.restored.receive(scope, report);
  expect(early.rows[0]?.observedAtMs).toBe(1_700_000_005_001);
  const normal = subject();
  await normal.restored.receive(scope, { ...report, restoredAtMs: 1_700_000_001_000 });
  expect(normal.rows[0]?.observedAtMs).toBe(1_700_000_001_000);
});

test("a failed publish is logged and does not undo the stored row", async () => {
  const rows: unknown[] = [];
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => void warnings.push(line);
  try {
    const restored = new CredentialRestoredActivity({
      agents: async () => [{ id: "agent-1", visibility: "public" }],
      newest: async () => ({
        detailKind: "runtime_error",
        level: "error",
        runtimeErrorReason: "auth_failed",
      }),
      record: async (activities) => void rows.push(...activities),
      publish: async () => {
        throw new Error("down");
      },
    });
    await expect(restored.receive(scope, report)).resolves.toBe(true);
    expect(rows).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  } finally {
    console.warn = warn;
  }
});
