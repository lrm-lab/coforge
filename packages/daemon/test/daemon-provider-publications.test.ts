import { expect, test } from "bun:test";
import {
  DAEMON_RUNTIME_RESET_CREDIT_RESULT_METHOD,
  RESET_CREDIT_CAPABILITY,
  decodeDaemonRuntimeResetCreditConsumeResponse,
  encodeDaemonRuntimeResetCreditConsumeRequest,
  encodeDaemonRuntimeUsageScanRequest,
  type DaemonRuntimeResetCreditConsumeRequest,
} from "@lrm/coforge-sdk/internal";
import { DaemonProviderPublications } from "#src/connection/daemon-provider-publications";
import { readyCapabilities } from "#src/daemon-runtime/ready-capabilities";

const request: DaemonRuntimeResetCreditConsumeRequest = {
  protocolMajor: 1,
  requestId: "reset-1",
  workspaceId: "workspace-a",
  computerId: "computer-a",
  provider: "codex",
  idempotencyKey: "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59",
};

function publications() {
  const received: DaemonRuntimeResetCreditConsumeRequest[] = [];
  const sent: Array<{ method: string; data: Uint8Array }> = [];
  const target = new DaemonProviderPublications(async (method, data) => {
    sent.push({ method, data });
  });
  target.onResetCreditConsume(async (value) => void received.push(value));
  return { target, received, sent };
}

test("a reset credit request for this Workspace reaches its listener", () => {
  const { target, received } = publications();
  expect(target.route(encodeDaemonRuntimeResetCreditConsumeRequest(request), "workspace-a")).toBe(
    true,
  );
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    requestId: "reset-1",
    idempotencyKey: request.idempotencyKey,
  });
});

test("a request for another Workspace, another protocol or a bad key is not taken", () => {
  const { target, received } = publications();
  for (const [value, workspace] of [
    [request, "workspace-b"],
    [{ ...request, protocolMajor: 2 }, "workspace-a"],
    [{ ...request, computerId: "" }, "workspace-a"],
    [{ ...request, idempotencyKey: "short" }, "workspace-a"],
    [{ ...request, idempotencyKey: `${request.idempotencyKey} ` }, "workspace-a"],
    [{ ...request, idempotencyKey: "" }, "workspace-a"],
  ] as const)
    expect(target.route(encodeDaemonRuntimeResetCreditConsumeRequest(value), workspace)).toBe(
      false,
    );
  expect(received).toEqual([]);
});

test("a usage scan request is still a usage scan request", () => {
  const { target, received } = publications();
  const scan = encodeDaemonRuntimeUsageScanRequest({
    protocolMajor: 1,
    requestId: "scan-1",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    provider: "codex",
  });
  expect(target.route(scan, "workspace-a")).toBe(true);
  expect(received).toEqual([]);
});

test("the answer goes to the reset credit result method", async () => {
  const { target, sent } = publications();
  await target.sendResetCreditConsumeResult({
    protocolMajor: 1,
    requestId: "reset-1",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    provider: "codex",
    outcome: "reset",
  });
  expect(sent.map((entry) => entry.method)).toEqual([DAEMON_RUNTIME_RESET_CREDIT_RESULT_METHOD]);
  expect(decodeDaemonRuntimeResetCreditConsumeResponse(sent[0]!.data)).toMatchObject({
    requestId: "reset-1",
    outcome: "reset",
  });
});

test("the daemon advertises the capability the cloud checks before it offers the action", () => {
  expect(readyCapabilities(false)).toContain(RESET_CREDIT_CAPABILITY);
  expect(readyCapabilities(false, true)).toContain(RESET_CREDIT_CAPABILITY);
});
