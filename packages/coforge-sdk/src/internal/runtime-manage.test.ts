import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "./runtime-provider";
import {
  RUNTIME_MANAGE_CAPABILITY,
  RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
  RUNTIME_MANAGE_RESULT_METHOD,
  decodeRuntimeManageRequest,
  decodeRuntimeManageResult,
  encodeRuntimeManageRequest,
  encodeRuntimeManageResult,
  isRuntimeManageRequest,
  isRuntimeManageRequestId,
  type RuntimeManageRequest,
  type RuntimeManageResult,
} from "./runtime-manage";

const VALID_REQUEST: RuntimeManageRequest = {
  protocolMajor: 1,
  requestId: "rtm_0123456789abcdef0123456789abcdef",
  workspaceId: "ws-1",
  computerId: "comp-1",
  provider: RUNTIME_PROVIDER.CODEX,
  action: "install",
  requestedByUserId: "user-1",
  timeoutMs: RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
};

const VALID_RESULT: RuntimeManageResult = {
  protocolMajor: 1,
  requestId: VALID_REQUEST.requestId,
  workspaceId: "ws-1",
  computerId: "comp-1",
  provider: RUNTIME_PROVIDER.CODEX,
  action: "install",
  requestedByUserId: "user-1",
  status: "installed",
  source: "npm",
  steps: ["npm install -g @openai/codex"],
  currentVersion: "0.151.0",
  durationMs: 12_345,
};

describe("runtime manage wire codec", () => {
  test("round-trips valid request and result envelopes", () => {
    expect(RUNTIME_MANAGE_CAPABILITY).toBe("runtime-manage:v1");
    expect(RUNTIME_MANAGE_RESULT_METHOD).toBe("daemon:v1:runtime_manage:result");
    expect(isRuntimeManageRequestId(VALID_REQUEST.requestId)).toBe(true);
    expect(isRuntimeManageRequestId("bad-id")).toBe(false);

    const requestBytes = encodeRuntimeManageRequest(VALID_REQUEST);
    expect(isRuntimeManageRequest(requestBytes)).toBe(true);
    expect(decodeRuntimeManageRequest(requestBytes)).toEqual(VALID_REQUEST);

    const resultBytes = encodeRuntimeManageResult(VALID_RESULT);
    expect(decodeRuntimeManageResult(resultBytes)).toEqual(VALID_RESULT);
  });

  test("round-trips failure results with exitCode, reason, and diagnostic", () => {
    const failed: RuntimeManageResult = {
      ...VALID_RESULT,
      action: "upgrade",
      status: "failed",
      reason: "command_failed",
      previousVersion: "0.140.0",
      exitCode: 1,
      diagnostic: "EACCES: permission denied",
      steps: [],
    };
    const decoded = decodeRuntimeManageResult(encodeRuntimeManageResult(failed));
    expect(decoded).toEqual({
      protocolMajor: 1,
      requestId: VALID_REQUEST.requestId,
      workspaceId: "ws-1",
      computerId: "comp-1",
      provider: RUNTIME_PROVIDER.CODEX,
      action: "upgrade",
      requestedByUserId: "user-1",
      status: "failed",
      reason: "command_failed",
      source: "npm",
      previousVersion: "0.140.0",
      currentVersion: "0.151.0",
      exitCode: 1,
      diagnostic: "EACCES: permission denied",
      durationMs: 12_345,
    });
  });

  test("rejects malformed requestIds, unknown actions, unknown statuses, and out-of-range timeouts", () => {
    expect(() =>
      encodeRuntimeManageRequest({ ...VALID_REQUEST, requestId: "not-a-valid-id" }),
    ).toThrow();
    expect(() =>
      encodeRuntimeManageRequest({
        ...VALID_REQUEST,
        action: "exec" as RuntimeManageRequest["action"],
      }),
    ).toThrow();
    expect(() => encodeRuntimeManageRequest({ ...VALID_REQUEST, timeoutMs: 500 })).toThrow();
    expect(() =>
      encodeRuntimeManageResult({
        ...VALID_RESULT,
        status: "bogus" as RuntimeManageResult["status"],
      }),
    ).toThrow();
    expect(() =>
      encodeRuntimeManageResult({
        ...VALID_RESULT,
        diagnostic: "x".repeat(600),
      }),
    ).toThrow();
  });
});
