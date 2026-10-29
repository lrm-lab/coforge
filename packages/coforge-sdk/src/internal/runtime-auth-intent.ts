import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { RuntimeAuthIntentSchema } from "#src/internal/gen/coforge/rpc/v1/runtime_auth_pb";
import {
  bounded,
  code,
  loginId,
  providerOf,
  requestId,
  scope,
  type RuntimeAuthProvider,
  type RuntimeAuthScope,
} from "./runtime-auth-fields";

import { runtimeAuthKiroOptions, type KiroIdentityCenterOptions } from "./runtime-auth-kiro";

const INTENT_TYPE = "coforge.rpc.v1.RuntimeAuthIntent";

export type RuntimeAuthIntent = RuntimeAuthScope &
  (
    | {
        kind: "login_start";
        loginId: string;
        provider: RuntimeAuthProvider;
        kiroIdentityCenter?: KiroIdentityCenterOptions;
      }
    | { kind: "login_code"; loginId: string; code: string }
    | { kind: "login_cancel"; loginId: string }
    | { kind: "logout"; requestId: string; provider: RuntimeAuthProvider }
    /** Read one runtime's login status again and report it, as when its page opens. */
    | { kind: "status_read"; provider: RuntimeAuthProvider }
  );

function checkIntent(value: RuntimeAuthIntent): RuntimeAuthIntent {
  const base = scope(value);
  switch (value.kind) {
    case "login_start": {
      const kiroIdentityCenter = runtimeAuthKiroOptions(value.provider, value.kiroIdentityCenter);
      return {
        ...base,
        kind: "login_start",
        loginId: loginId(value.loginId),
        provider: providerOf(value.provider),
        ...(kiroIdentityCenter ? { kiroIdentityCenter } : {}),
      };
    }
    case "login_code":
      return {
        ...base,
        kind: "login_code",
        loginId: loginId(value.loginId),
        code: code(value.code),
      };
    case "login_cancel":
      return { ...base, kind: "login_cancel", loginId: loginId(value.loginId) };
    case "logout":
      return {
        ...base,
        kind: "logout",
        requestId: requestId(value.requestId),
        provider: providerOf(value.provider),
      };
    case "status_read":
      return { ...base, kind: "status_read", provider: providerOf(value.provider) };
    default:
      throw new Error("invalid runtime auth intent");
  }
}

export function encodeRuntimeAuthIntent(value: RuntimeAuthIntent): Uint8Array {
  const checked = checkIntent(value);
  const { protocolMajor, workspaceId, computerId } = checked;
  const kind = (() => {
    switch (checked.kind) {
      case "login_start":
        return {
          case: "loginStart" as const,
          value: {
            loginId: checked.loginId,
            provider: checked.provider,
            kiroIdentityCenter: checked.kiroIdentityCenter,
          },
        };
      case "login_code":
        return {
          case: "loginCode" as const,
          value: { loginId: checked.loginId, code: checked.code },
        };
      case "login_cancel":
        return { case: "loginCancel" as const, value: { loginId: checked.loginId } };
      case "logout":
        return {
          case: "logout" as const,
          value: { requestId: checked.requestId, provider: checked.provider },
        };
      case "status_read":
        return {
          case: "statusRead" as const,
          value: { provider: checked.provider },
        };
    }
  })();
  return bounded(
    toBinary(
      RuntimeAuthIntentSchema,
      create(RuntimeAuthIntentSchema, {
        protocolMajor,
        workspaceId,
        computerId,
        kind,
        messageType: INTENT_TYPE,
      }),
    ),
  );
}

export function decodeRuntimeAuthIntent(bytes: Uint8Array): RuntimeAuthIntent {
  const wire = fromBinary(RuntimeAuthIntentSchema, bounded(bytes));
  if (wire.messageType !== INTENT_TYPE) throw new Error("invalid runtime auth intent");
  const base = {
    protocolMajor: wire.protocolMajor as 1,
    workspaceId: wire.workspaceId,
    computerId: wire.computerId,
  };
  const body = wire.kind;
  switch (body.case) {
    case "loginStart":
      return checkIntent({ ...base, kind: "login_start", ...body.value } as RuntimeAuthIntent);
    case "loginCode":
      return checkIntent({ ...base, kind: "login_code", ...body.value } as RuntimeAuthIntent);
    case "loginCancel":
      return checkIntent({ ...base, kind: "login_cancel", ...body.value } as RuntimeAuthIntent);
    case "logout":
      return checkIntent({ ...base, kind: "logout", ...body.value } as RuntimeAuthIntent);
    case "statusRead":
      return checkIntent({ ...base, kind: "status_read", ...body.value } as RuntimeAuthIntent);
    default:
      throw new Error("invalid runtime auth intent");
  }
}
