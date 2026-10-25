import { expect, test } from "bun:test";
import {
  RUNTIME_AUTH_STATUS_REPORT_METHOD,
  decodeRuntimeAuthStatusReport,
  type RuntimeAuthStatusReport,
} from "@lrm/coforge-sdk/internal";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";

const connectionConfig = {
  workspaceId: "workspace-a",
  computerId: "computer-a",
  daemonId: "daemon-a",
  daemonInstanceId: "daemon-instance-a",
  expectedServerUrl: "https://cloud.example",
};

const report: RuntimeAuthStatusReport = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-a",
  computerId: "computer-a",
  collectedAtMs: 1_700_000_000_000,
  runtimes: [
    {
      provider: "codex",
      state: "logged_in",
      account: { maskedLabel: "a***@example.com", planLabel: "plus" },
    },
    { provider: "claude-code", state: "unavailable", unavailableReason: "not_installed" },
  ],
};

function fakeClient(rpc?: CentrifugeWorkspaceClient["rpc"]) {
  let connected = () => {};
  const calls: { method: string; data: Uint8Array }[] = [];
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc:
      rpc ??
      (async (method, data) => {
        calls.push({ method, data });
        return new Uint8Array();
      }),
  };
  return { client, calls };
}

test("the runtime auth report goes out on its RPC method, encoded", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", connectionConfig);

  await transport.reportRuntimeAuthStatus(report);

  const sent = fake.calls.filter(({ method }) => method === RUNTIME_AUTH_STATUS_REPORT_METHOD);
  expect(sent).toHaveLength(1);
  expect(decodeRuntimeAuthStatusReport(sent[0]!.data)).toEqual(report);
});

test("a server that refuses the unknown method rejects the report", async () => {
  const fake = fakeClient(async () => {
    throw new Error("404 unknown RPC method");
  });
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", connectionConfig);

  await expect(transport.reportRuntimeAuthStatus(report)).rejects.toThrow("unknown RPC method");
});
