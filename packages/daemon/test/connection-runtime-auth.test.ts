import { expect, test } from "bun:test";
import {
  encodeRuntimeAuthIntent,
  decodeRuntimeAuthLoginReport,
  decodeRuntimeAuthLogoutReport,
  RUNTIME_AUTH_LOGIN_REPORT_METHOD,
  RUNTIME_AUTH_LOGOUT_REPORT_METHOD,
  type RuntimeAuthIntent,
} from "@lrm/coforge-sdk/internal";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { captureDaemonLogs } from "./log-capture";

const scope = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };
const loginId = "rtl_abcdefghijklmnop";

function connection() {
  let connected = () => {};
  let publication = (_value: { channel: string; data: Uint8Array }) => {};
  const calls: { method: string; data: Uint8Array }[] = [];
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as typeof connected;
      if (event === "publication") publication = callback as typeof publication;
    },
    connect: () => connected(),
    disconnect() {},
    rpc: async (method, data) => {
      calls.push({ method, data });
      return new Uint8Array();
    },
  };
  const transport = new DaemonConnection("wss://cloud.invalid", () => client);
  return {
    transport,
    calls,
    publish: (data: Uint8Array, channel = "daemon:workspace-a:computer-a") =>
      publication({ channel, data }),
  };
}

test("routes all four scoped auth intents and sends login/logout reports only through their SDK RPC methods", async () => {
  const { transport, calls, publish } = connection();
  const received: RuntimeAuthIntent[] = [];
  await transport.start("fixture-token", scope);
  try {
    const unsubscribe = transport.onRuntimeAuth((intent) => received.push(intent));
    const intents: RuntimeAuthIntent[] = [
      { ...scope, kind: "login_start", loginId, provider: "codex" },
      { ...scope, kind: "login_code", loginId, code: "sentinel-private-code" },
      { ...scope, kind: "login_cancel", loginId },
      { ...scope, kind: "logout", requestId: "logout-1", provider: "codex" },
    ];
    const { records } = await captureDaemonLogs(async () => {
      for (const intent of intents) publish(encodeRuntimeAuthIntent(intent));
      publish(encodeRuntimeAuthIntent({ ...intents[0]!, workspaceId: "workspace-other" }));
      publish(encodeRuntimeAuthIntent({ ...intents[0]!, computerId: "computer-other" }));
      publish(encodeRuntimeAuthIntent(intents[1]!), "daemon:workspace-a:computer-other");
      publish(new TextEncoder().encode(JSON.stringify({ code: "sentinel-private-code", loginId })));
    });
    expect(received).toEqual(intents);
    expect(JSON.stringify(records)).not.toContain("sentinel-private-code");
    const login = { ...scope, loginId, sequence: 1, result: { kind: "cancelled" as const } };
    const logout = { ...scope, requestId: "logout-1", result: { kind: "logged_out" as const } };
    await transport.reportRuntimeAuthLogin(login);
    await transport.reportRuntimeAuthLogout(logout);
    expect(
      decodeRuntimeAuthLoginReport(
        calls.find((call) => call.method === RUNTIME_AUTH_LOGIN_REPORT_METHOD)!.data,
      ),
    ).toEqual(login);
    expect(
      decodeRuntimeAuthLogoutReport(
        calls.find((call) => call.method === RUNTIME_AUTH_LOGOUT_REPORT_METHOD)!.data,
      ),
    ).toEqual(logout);
    unsubscribe();
    publish(encodeRuntimeAuthIntent(intents[0]!));
    expect(received).toHaveLength(4);
  } finally {
    await transport.stop();
  }
});
