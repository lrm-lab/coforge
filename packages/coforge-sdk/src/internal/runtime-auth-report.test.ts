import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  RuntimeAuthStateKind,
  RuntimeAuthStatusReportSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  RUNTIME_AUTH_STATUS_REPORT_METHOD,
  decodeRuntimeAuthStatusReport,
  encodeRuntimeAuthStatusReport,
  type RuntimeAuthStatusReport,
} from "./index";

const report = (): RuntimeAuthStatusReport => ({
  protocolMajor: 1,
  requestId: "auth-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  collectedAtMs: 1_761_350_400_000,
  runtimes: [
    {
      provider: "claude-code",
      state: "logged_in",
      account: { maskedLabel: "f***@example.com", planLabel: "Max", methodLabel: "Claude account" },
    },
    { provider: "codex", state: "unavailable", unavailableReason: "version_unsupported" },
  ],
});

test("the report travels on the daemon namespace", () => {
  expect(RUNTIME_AUTH_STATUS_REPORT_METHOD).toBe("daemon:v1:runtime_auth:status_report");
});

test("round-trips every state and reason", () => {
  const value = report();
  expect(decodeRuntimeAuthStatusReport(encodeRuntimeAuthStatusReport(value))).toEqual(value);
  for (const state of ["logged_out", "unknown"] as const) {
    const one = { ...value, runtimes: [{ provider: "codex", state }] };
    expect(decodeRuntimeAuthStatusReport(encodeRuntimeAuthStatusReport(one))).toEqual(one);
  }
  for (const unavailableReason of [
    "not_installed",
    "version_unsupported",
    "unsupported_installation",
  ] as const) {
    const one = {
      ...value,
      runtimes: [{ provider: "codex", state: "unavailable" as const, unavailableReason }],
    };
    expect(decodeRuntimeAuthStatusReport(encodeRuntimeAuthStatusReport(one))).toEqual(one);
  }
});

test("a state the receiver does not know, or an unavailable one without a reason, reads as unknown", () => {
  const bytes = toBinary(
    RuntimeAuthStatusReportSchema,
    create(RuntimeAuthStatusReportSchema, {
      protocolMajor: 1,
      requestId: "auth-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      collectedAtMs: 1n,
      runtimes: [
        {
          provider: "codex",
          state: RuntimeAuthStateKind.UNSPECIFIED,
          account: { maskedLabel: "a***" },
        },
        { provider: "claude-code", state: 99 as RuntimeAuthStateKind },
        { provider: "codex", state: RuntimeAuthStateKind.UNAVAILABLE },
        {
          provider: "codex",
          state: RuntimeAuthStateKind.LOGGED_OUT,
          account: { planLabel: "Pro" },
        },
      ],
    }),
  );
  expect(decodeRuntimeAuthStatusReport(bytes).runtimes).toEqual([
    { provider: "codex", state: "unknown" },
    { provider: "claude-code", state: "unknown" },
    { provider: "codex", state: "unknown" },
    { provider: "codex", state: "logged_out" },
  ]);
});

test("refuses another protocol, a missing scope field, or an oversized payload", () => {
  expect(() => encodeRuntimeAuthStatusReport({ ...report(), protocolMajor: 2 })).toThrow(
    "invalid runtime auth status report",
  );
  for (const field of ["requestId", "workspaceId", "computerId"] as const)
    expect(() => encodeRuntimeAuthStatusReport({ ...report(), [field]: "" }), field).toThrow(
      "invalid runtime auth status report",
    );
  expect(() => decodeRuntimeAuthStatusReport(new Uint8Array(16_385))).toThrow("too large");
});

test("keeps wire tags stable", () => {
  const fields = Object.fromEntries(
    RuntimeAuthStatusReportSchema.fields.map((field) => [field.localName, field.number]),
  );
  expect(fields).toEqual({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    computerId: 4,
    collectedAtMs: 5,
    runtimes: 6,
  });
});
