import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  RuntimeAuthLoginEventSchema,
  RuntimeAuthLoginReportSchema,
  RuntimeAuthLoginResultSchema,
  type RuntimeAuthLoginEvent as WireEvent,
  type RuntimeAuthLoginResult as WireResult,
} from "#src/internal/gen/coforge/rpc/v1/runtime_auth_pb";
import {
  MASK_MARKER,
  MAX_DEVICE_CODE_SECONDS,
  MAX_LABEL,
  MAX_MESSAGE,
  MAX_METHOD_LABEL,
  MAX_USER_CODE,
  RUNTIME_AUTH_LOGIN_FAILURE_REASONS,
  bounded,
  checkFailed,
  checkUnsupported,
  defined,
  httpsUrl,
  loginId,
  optionalText,
  scope,
  sequence,
  text,
  type RuntimeAuthScope,
  type Unsupported,
} from "./runtime-auth-fields";

const LOGIN_REPORT_TYPE = "coforge.rpc.v1.RuntimeAuthLoginReport";

export type RuntimeAuthAccount = { maskedLabel?: string; planLabel?: string; methodLabel?: string };

export type RuntimeAuthLoginEvent =
  | { kind: "auth_url"; url: string; instructions?: string }
  | { kind: "device_code"; userCode: string; verificationUrl: string; expiresInSeconds?: number }
  | { kind: "info"; message: string }
  | { kind: "code_prompt"; message?: string; retry?: boolean };

export type RuntimeAuthLoginResult =
  | { kind: "logged_in"; account?: RuntimeAuthAccount }
  | {
      kind: "failed";
      reason: (typeof RUNTIME_AUTH_LOGIN_FAILURE_REASONS)[number];
      detail?: string;
    }
  | { kind: "cancelled" }
  | Unsupported
  | { kind: "busy" };

/** One login's progress or its terminal result, ordered by `sequence`. */
export type RuntimeAuthLoginReport = RuntimeAuthScope & { loginId: string; sequence: number } & (
    | { event: RuntimeAuthLoginEvent; result?: undefined }
    | { result: RuntimeAuthLoginResult; event?: undefined }
  );

function checkAccount(account: RuntimeAuthAccount): RuntimeAuthAccount {
  const maskedLabel = optionalText(account.maskedLabel, MAX_LABEL, "account label");
  if (maskedLabel !== undefined && !MASK_MARKER.test(maskedLabel))
    throw new Error("invalid runtime auth account label: it must carry a mask marker");
  const checked = defined({
    maskedLabel,
    planLabel: optionalText(account.planLabel, MAX_LABEL, "plan label"),
    methodLabel: optionalText(account.methodLabel, MAX_METHOD_LABEL, "method label"),
  });
  if (Object.keys(checked).length === 0) throw new Error("invalid runtime auth account: empty");
  return checked;
}

function checkEvent(event: RuntimeAuthLoginEvent): RuntimeAuthLoginEvent {
  switch (event.kind) {
    case "auth_url":
      return defined({
        kind: "auth_url" as const,
        url: httpsUrl(event.url),
        instructions: optionalText(event.instructions, MAX_MESSAGE, "instructions"),
      });
    case "device_code": {
      const expires = event.expiresInSeconds;
      if (
        expires !== undefined &&
        (!Number.isSafeInteger(expires) || expires < 1 || expires > MAX_DEVICE_CODE_SECONDS)
      )
        throw new Error("invalid runtime auth device code lifetime");
      return defined({
        kind: "device_code" as const,
        userCode: text(event.userCode, MAX_USER_CODE, "user code"),
        verificationUrl: httpsUrl(event.verificationUrl),
        expiresInSeconds: expires,
      });
    }
    case "info":
      return { kind: "info", message: text(event.message, MAX_MESSAGE, "message") };
    case "code_prompt":
      return defined({
        kind: "code_prompt" as const,
        message: optionalText(event.message, MAX_MESSAGE, "message"),
        retry: event.retry,
      });
    default:
      throw new Error("invalid runtime auth event");
  }
}

function checkLoginResult(result: RuntimeAuthLoginResult): RuntimeAuthLoginResult {
  switch (result.kind) {
    case "logged_in":
      return defined({
        kind: "logged_in" as const,
        account: result.account && checkAccount(result.account),
      });
    case "failed":
      return { kind: "failed", ...checkFailed(result, RUNTIME_AUTH_LOGIN_FAILURE_REASONS) };
    case "cancelled":
    case "busy":
      return { kind: result.kind };
    case "unsupported":
      return checkUnsupported(result);
    default:
      throw new Error("invalid runtime auth login result");
  }
}

function checkLoginReport(value: RuntimeAuthLoginReport): RuntimeAuthLoginReport {
  const base = {
    ...scope(value),
    loginId: loginId(value.loginId),
    sequence: sequence(value.sequence),
  };
  if ((value.event == null) === (value.result == null))
    throw new Error("invalid runtime auth report: it carries exactly one of event and result");
  return value.event
    ? { ...base, event: checkEvent(value.event) }
    : { ...base, result: checkLoginResult(value.result!) };
}

function eventToWire(
  event: RuntimeAuthLoginEvent,
): MessageInitShape<typeof RuntimeAuthLoginEventSchema>["kind"] {
  switch (event.kind) {
    case "auth_url":
      return {
        case: "authUrl" as const,
        value: { url: event.url, instructions: event.instructions },
      };
    case "device_code":
      return {
        case: "deviceCode" as const,
        value: {
          userCode: event.userCode,
          verificationUrl: event.verificationUrl,
          expiresInSeconds: event.expiresInSeconds,
        },
      };
    case "info":
      return { case: "info" as const, value: { message: event.message } };
    case "code_prompt":
      return {
        case: "codePrompt" as const,
        value: { message: event.message, retry: event.retry },
      };
  }
}

function eventFromWire(event: WireEvent): RuntimeAuthLoginEvent {
  const body = event.kind;
  switch (body.case) {
    case "authUrl":
      return { kind: "auth_url", url: body.value.url, instructions: body.value.instructions };
    case "deviceCode":
      return {
        kind: "device_code",
        userCode: body.value.userCode,
        verificationUrl: body.value.verificationUrl,
        expiresInSeconds: body.value.expiresInSeconds,
      };
    case "info":
      return { kind: "info", message: body.value.message };
    case "codePrompt":
      return { kind: "code_prompt", message: body.value.message, retry: body.value.retry };
    default:
      throw new Error("invalid runtime auth event");
  }
}

function loginResultToWire(
  result: RuntimeAuthLoginResult,
): MessageInitShape<typeof RuntimeAuthLoginResultSchema>["kind"] {
  switch (result.kind) {
    case "logged_in":
      return { case: "loggedIn" as const, value: { account: result.account } };
    case "failed":
      return { case: "failed" as const, value: { reason: result.reason, detail: result.detail } };
    case "cancelled":
      return { case: "cancelled" as const, value: {} };
    case "unsupported":
      return {
        case: "unsupported" as const,
        value: { reason: result.reason, detail: result.detail },
      };
    case "busy":
      return { case: "busy" as const, value: {} };
  }
}

function loginResultFromWire(result: WireResult): RuntimeAuthLoginResult {
  const body = result.kind;
  switch (body.case) {
    case "loggedIn": {
      const account = body.value.account;
      return {
        kind: "logged_in",
        account: account && {
          maskedLabel: account.maskedLabel,
          planLabel: account.planLabel,
          methodLabel: account.methodLabel,
        },
      };
    }
    case "failed":
      return {
        kind: "failed",
        reason: body.value.reason,
        detail: body.value.detail,
      } as RuntimeAuthLoginResult;
    case "cancelled":
      return { kind: "cancelled" };
    case "unsupported":
      return {
        kind: "unsupported",
        reason: body.value.reason,
        detail: body.value.detail,
      } as RuntimeAuthLoginResult;
    case "busy":
      return { kind: "busy" };
    default:
      throw new Error("invalid runtime auth login result");
  }
}

export function encodeRuntimeAuthLoginReport(value: RuntimeAuthLoginReport): Uint8Array {
  const checked = checkLoginReport(value);
  const report = checked.event
    ? { case: "event" as const, value: { kind: eventToWire(checked.event) } }
    : { case: "result" as const, value: { kind: loginResultToWire(checked.result!) } };
  return bounded(
    toBinary(
      RuntimeAuthLoginReportSchema,
      create(RuntimeAuthLoginReportSchema, {
        protocolMajor: checked.protocolMajor,
        workspaceId: checked.workspaceId,
        computerId: checked.computerId,
        loginId: checked.loginId,
        sequence: checked.sequence,
        report,
        messageType: LOGIN_REPORT_TYPE,
      }),
    ),
  );
}

export function decodeRuntimeAuthLoginReport(bytes: Uint8Array): RuntimeAuthLoginReport {
  const wire = fromBinary(RuntimeAuthLoginReportSchema, bounded(bytes));
  if (wire.messageType !== LOGIN_REPORT_TYPE) throw new Error("invalid runtime auth login report");
  const base = {
    protocolMajor: wire.protocolMajor as 1,
    workspaceId: wire.workspaceId,
    computerId: wire.computerId,
    loginId: wire.loginId,
    sequence: wire.sequence,
  };
  switch (wire.report.case) {
    case "event":
      return checkLoginReport({ ...base, event: eventFromWire(wire.report.value) });
    case "result":
      return checkLoginReport({ ...base, result: loginResultFromWire(wire.report.value) });
    default:
      throw new Error("invalid runtime auth report: it carries neither event nor result");
  }
}
