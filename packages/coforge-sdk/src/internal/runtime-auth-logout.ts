import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  RuntimeAuthLogoutReportSchema,
  RuntimeAuthLogoutResultSchema,
  type RuntimeAuthLogoutResult as WireLogoutResult,
} from "#src/internal/gen/coforge/rpc/v1/runtime_auth_pb";
import {
  RUNTIME_AUTH_LOGOUT_FAILURE_REASONS,
  bounded,
  checkFailed,
  checkUnsupported,
  requestId,
  scope,
  type RuntimeAuthScope,
  type Unsupported,
} from "./runtime-auth-fields";

const LOGOUT_REPORT_TYPE = "coforge.rpc.v1.RuntimeAuthLogoutReport";

export type RuntimeAuthLogoutResult =
  | { kind: "logged_out" }
  | {
      kind: "failed";
      reason: (typeof RUNTIME_AUTH_LOGOUT_FAILURE_REASONS)[number];
      detail?: string;
    }
  | Unsupported;

export type RuntimeAuthLogoutReport = RuntimeAuthScope & {
  requestId: string;
  result: RuntimeAuthLogoutResult;
};

function checkLogoutResult(result: RuntimeAuthLogoutResult): RuntimeAuthLogoutResult {
  switch (result.kind) {
    case "logged_out":
      return { kind: "logged_out" };
    case "failed":
      return { kind: "failed", ...checkFailed(result, RUNTIME_AUTH_LOGOUT_FAILURE_REASONS) };
    case "unsupported":
      return checkUnsupported(result);
    default:
      throw new Error("invalid runtime auth logout result");
  }
}

function logoutResultToWire(
  result: RuntimeAuthLogoutResult,
): MessageInitShape<typeof RuntimeAuthLogoutResultSchema>["kind"] {
  switch (result.kind) {
    case "logged_out":
      return { case: "loggedOut" as const, value: {} };
    case "failed":
      return { case: "failed" as const, value: { reason: result.reason, detail: result.detail } };
    case "unsupported":
      return {
        case: "unsupported" as const,
        value: { reason: result.reason, detail: result.detail },
      };
  }
}

function logoutResultFromWire(result: WireLogoutResult | undefined): RuntimeAuthLogoutResult {
  const body = result?.kind;
  switch (body?.case) {
    case "loggedOut":
      return { kind: "logged_out" };
    case "failed":
      return {
        kind: "failed",
        reason: body.value.reason,
        detail: body.value.detail,
      } as RuntimeAuthLogoutResult;
    case "unsupported":
      return {
        kind: "unsupported",
        reason: body.value.reason,
        detail: body.value.detail,
      } as RuntimeAuthLogoutResult;
    default:
      throw new Error("invalid runtime auth logout result");
  }
}

function checkLogoutReport(value: RuntimeAuthLogoutReport): RuntimeAuthLogoutReport {
  return {
    ...scope(value),
    requestId: requestId(value.requestId),
    result: checkLogoutResult(value.result),
  };
}

export function encodeRuntimeAuthLogoutReport(value: RuntimeAuthLogoutReport): Uint8Array {
  const checked = checkLogoutReport(value);
  return bounded(
    toBinary(
      RuntimeAuthLogoutReportSchema,
      create(RuntimeAuthLogoutReportSchema, {
        protocolMajor: checked.protocolMajor,
        workspaceId: checked.workspaceId,
        computerId: checked.computerId,
        requestId: checked.requestId,
        result: { kind: logoutResultToWire(checked.result) },
        messageType: LOGOUT_REPORT_TYPE,
      }),
    ),
  );
}

export function decodeRuntimeAuthLogoutReport(bytes: Uint8Array): RuntimeAuthLogoutReport {
  const wire = fromBinary(RuntimeAuthLogoutReportSchema, bounded(bytes));
  if (wire.messageType !== LOGOUT_REPORT_TYPE)
    throw new Error("invalid runtime auth logout report");
  return checkLogoutReport({
    protocolMajor: wire.protocolMajor as 1,
    workspaceId: wire.workspaceId,
    computerId: wire.computerId,
    requestId: wire.requestId,
    result: logoutResultFromWire(wire.result),
  });
}
