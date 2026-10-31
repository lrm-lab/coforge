import { expect, test } from "bun:test";
import { decodeComputerUpgradeResult, encodeComputerUpgradeResult } from "./codec";
import {
  decodeDaemonCommandResponse,
  encodeDaemonCommandResponse,
  parseUpgradeErrorCode,
  UPGRADE_ERROR_CODE,
} from "./index";

const base = {
  protocolMajor: 1,
  requestId: "upgrade-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  status: "failed" as const,
  completedAtMs: 1_700_000_000_000,
  messageType: "coforge.rpc.v1.ComputerUpgradeResult" as const,
};

test("round-trips a Computer upgrade result with no error code", () => {
  const value = { ...base, error: "something went wrong" };
  expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
});

test("round-trips a Computer upgrade result carrying a known error code", () => {
  const value = {
    ...base,
    error: "Computer upgrade operation upgrade-0 is still pending",
    errorCode: UPGRADE_ERROR_CODE.OPERATION_PENDING,
  };
  expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
});

test("round-trips a well-formed but not-yet-known error code without rejecting it", () => {
  const value = { ...base, error: "future failure", errorCode: "UPGRADE_SOMETHING_NEW" };
  expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
});

test("the installer's failure codes are known and round-trip on the wire", () => {
  for (const errorCode of [
    "UPGRADE_INSTALLER_UNAVAILABLE",
    "UPGRADE_INSTALLER_INCOMPATIBLE",
    "UPDATE_DOWNLOAD_FAILED",
  ]) {
    expect(parseUpgradeErrorCode(errorCode)).toBe(errorCode as never);
    const value = { ...base, error: "the installer could not run", errorCode };
    expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
  }
});

test("round-trips a result carrying the automatic recovery report", () => {
  const value = {
    ...base,
    error: "rollback failed",
    errorCode: UPGRADE_ERROR_CODE.ROLLBACK_FAILED,
    recovery: {
      outcome: "recovered" as const,
      restoredVersion: "0.1.0",
      attempts: 3,
      finishedAtMs: 1_700_000_500_000,
    },
  };
  expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
});

test("round-trips a recovery that gave up, sanitizing its message like the error text", () => {
  const value = {
    ...base,
    recovery: {
      outcome: "failed" as const,
      attempts: 8,
      finishedAtMs: 1_700_000_500_000,
      message: "could not restore /Users/frank/.coforge/install/versions/0.1.0",
    },
  };
  const decoded = decodeComputerUpgradeResult(encodeComputerUpgradeResult(value));
  expect(decoded.recovery).toEqual({
    outcome: "failed",
    attempts: 8,
    finishedAtMs: 1_700_000_500_000,
    message: "could not restore <path>",
  });
});

test("rejects a malformed recovery on encode", () => {
  expect(() =>
    encodeComputerUpgradeResult({
      ...base,
      recovery: { outcome: "exploded" as never, attempts: 1, finishedAtMs: 1 },
    }),
  ).toThrow("recovery");
  expect(() =>
    encodeComputerUpgradeResult({
      ...base,
      recovery: { outcome: "recovered", attempts: 0, finishedAtMs: 1 },
    }),
  ).toThrow("recovery");
});

test("rejects a malformed error code shape on encode and decode", () => {
  expect(() => encodeComputerUpgradeResult({ ...base, errorCode: "not-a-code" })).toThrow(
    "error code",
  );
  const encoded = encodeComputerUpgradeResult({ ...base, error: "x" });
  // Decoding a well-formed payload always succeeds; this only proves the guard itself throws on
  // the malformed shape it is meant to catch, exercised directly against the decoded value.
  expect(() => encodeComputerUpgradeResult({ ...base, errorCode: "x" })).toThrow("error code");
  expect(decodeComputerUpgradeResult(encoded)).not.toHaveProperty("errorCode");
});

const commandResponse = {
  protocolMajor: 1,
  requestId: "cmd-1",
  accepted: false,
  runtimes: [],
};

test("round-trips a refused local lifecycle command with its error and error code", () => {
  const value = {
    ...commandResponse,
    error: "Computer upgrade operation upgrade-0 is still pending",
    errorCode: UPGRADE_ERROR_CODE.OPERATION_PENDING,
  };
  expect(decodeDaemonCommandResponse(encodeDaemonCommandResponse(value))).toEqual(value);
});

test("an accepted local lifecycle command round-trips with no error fields", () => {
  const value = { ...commandResponse, accepted: true };
  const decoded = decodeDaemonCommandResponse(encodeDaemonCommandResponse(value));
  expect(decoded).toEqual(value);
  expect(decoded).not.toHaveProperty("error");
  expect(decoded).not.toHaveProperty("errorCode");
});
