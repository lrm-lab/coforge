import { expect, test } from "bun:test";
import {
  encodeRuntimeAuthLoginReport,
  encodeRuntimeAuthLogoutReport,
  RUNTIME_AUTH_LOGIN_REPORT_METHOD,
  RUNTIME_AUTH_LOGOUT_REPORT_METHOD,
} from "@lrm/coforge-sdk/internal";
import { createRuntimeAuthReportMethods } from "#src/server/centrifugo/runtime-auth-receiver.server";
import type { CentrifugoRpcMetadata } from "#src/server/centrifugo/rpc-handler.server";

const daemon: CentrifugoRpcMetadata = {
  principal: { userId: "daemon", workspaceId: "w", computerId: "c" },
};
const scope = { protocolMajor: 1 as const, workspaceId: "w", computerId: "c" };
const login = encodeRuntimeAuthLoginReport({
  ...scope,
  loginId: "rtl_abcdefghijklmnop",
  sequence: 1,
  result: { kind: "busy" },
});
const logout = encodeRuntimeAuthLogoutReport({
  ...scope,
  requestId: "request-1",
  result: { kind: "logged_out" },
});

function methods(overrides: { accept?: boolean; fail?: boolean } = {}) {
  const received: unknown[] = [];
  const answer = async (_scope: unknown, report: unknown) => {
    received.push(report);
    if (overrides.fail) throw new Error("redis down");
    return overrides.accept ?? true;
  };
  return {
    received,
    methods: createRuntimeAuthReportMethods({
      receiveLoginReport: answer,
      receiveLogoutReport: answer,
    }),
  };
}

test("a daemon's reports reach the service", async () => {
  const { methods: m, received } = methods();
  expect(await m[RUNTIME_AUTH_LOGIN_REPORT_METHOD]!(login, daemon)).toEqual(new Uint8Array());
  expect(await m[RUNTIME_AUTH_LOGOUT_REPORT_METHOD]!(logout, daemon)).toEqual(new Uint8Array());
  expect(received).toHaveLength(2);
});

test("a report from another Computer or Workspace, garbage, or a non-daemon is refused", async () => {
  const { methods: m, received } = methods();
  const refused = { code: 403, message: "Runtime auth report is not authorized" };
  const other = { principal: { ...daemon.principal, computerId: "c2" } } as CentrifugoRpcMetadata;
  expect(await m[RUNTIME_AUTH_LOGIN_REPORT_METHOD]!(login, other)).toEqual(refused);
  expect(await m[RUNTIME_AUTH_LOGOUT_REPORT_METHOD]!(logout, other)).toEqual(refused);
  expect(await m[RUNTIME_AUTH_LOGIN_REPORT_METHOD]!(logout, daemon)).toEqual(refused);
  expect(await m[RUNTIME_AUTH_LOGIN_REPORT_METHOD]!(new Uint8Array([1, 2, 3]), daemon)).toEqual(
    refused,
  );
  expect(received).toEqual([]);
});

test("a login the service does not hold is a 403, and a store failure a 503", async () => {
  expect(
    await methods({ accept: false }).methods[RUNTIME_AUTH_LOGIN_REPORT_METHOD]!(login, daemon),
  ).toEqual({
    code: 403,
    message: "Runtime auth report is not authorized",
  });
  expect(
    await methods({ fail: true }).methods[RUNTIME_AUTH_LOGOUT_REPORT_METHOD]!(logout, daemon),
  ).toEqual({
    code: 503,
    message: "Runtime auth report could not be stored",
  });
});
