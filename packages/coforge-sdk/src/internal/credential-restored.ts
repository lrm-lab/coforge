import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentCredentialRestoredSchema } from "#src/internal/gen/coforge/rpc/v1/agent_credential_pb";
import { RPC_METHODS } from "./rpc-methods";
import { boundedPayload } from "./bounded-payload";

/** Daemon -> server: an Agent's provider credential works again. Best-effort. */
export const AGENT_CREDENTIAL_RESTORED_METHOD = RPC_METHODS.agentCredentialRestored;

/** What an Agent showed of the credential failure that has ended. */
export const CREDENTIAL_RESTORED_REASONS = [
  "user_reauth",
  "user_model_access",
  "BillingError",
] as const;
export type CredentialRestoredReason = (typeof CREDENTIAL_RESTORED_REASONS)[number];

/** The `runtimeError.errorReason` the failure Activity of each reason carries, which is how a
 * receiver tells the Activity that failure left from any other error. */
export const CREDENTIAL_FAILURE_ERROR_REASONS: Readonly<Record<CredentialRestoredReason, string>> =
  {
    user_reauth: "auth_failed",
    user_model_access: "model_config_error",
    BillingError: "billing_exhausted",
  };

/** What made the credential usable again, as the daemon knows it. */
export const CREDENTIAL_RELEASE_CAUSES = [
  "credentials_changed",
  "explicit_stop",
  "model_changed",
  "model_output",
] as const;
export type CredentialReleaseCause = (typeof CREDENTIAL_RELEASE_CAUSES)[number];

export type AgentCredentialRestored = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  reason: CredentialRestoredReason;
  releaseCause: CredentialReleaseCause;
  /** The Agent's running launch, when it had one. */
  launchId?: string;
  /** When the daemon found the credential usable again, on the clock of the Agent's Activities. */
  restoredAtMs: number;
};

const MAX_ID_LENGTH = 512;
const MAX_REPORT_BYTES = 4_096;
const isId = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;

function checked(
  value: Omit<AgentCredentialRestored, "reason" | "releaseCause" | "launchId"> & {
    reason: string;
    releaseCause: string;
    launchId?: string;
  },
): void {
  if (
    value.protocolMajor !== 1 ||
    !isId(value.requestId) ||
    !isId(value.workspaceId) ||
    !isId(value.agentId) ||
    !(CREDENTIAL_RESTORED_REASONS as readonly string[]).includes(value.reason) ||
    !(CREDENTIAL_RELEASE_CAUSES as readonly string[]).includes(value.releaseCause) ||
    (value.launchId !== undefined && !isId(value.launchId)) ||
    !Number.isSafeInteger(value.restoredAtMs) ||
    value.restoredAtMs < 1
  )
    throw new Error("invalid credential restored");
}

export function encodeAgentCredentialRestored(value: AgentCredentialRestored): Uint8Array {
  checked(value);
  return boundedPayload(
    toBinary(
      AgentCredentialRestoredSchema,
      create(AgentCredentialRestoredSchema, {
        ...value,
        launchId: value.launchId ?? "",
        restoredAtMs: BigInt(value.restoredAtMs),
      }),
    ),
    MAX_REPORT_BYTES,
    "credential restored",
  );
}

export function decodeAgentCredentialRestored(bytes: Uint8Array): AgentCredentialRestored {
  const {
    $typeName: _,
    launchId,
    restoredAtMs,
    ...value
  } = fromBinary(
    AgentCredentialRestoredSchema,
    boundedPayload(bytes, MAX_REPORT_BYTES, "credential restored"),
  );
  checked({ ...value, restoredAtMs: Number(restoredAtMs), ...(launchId ? { launchId } : {}) });
  return {
    ...value,
    restoredAtMs: Number(restoredAtMs),
    reason: value.reason as CredentialRestoredReason,
    releaseCause: value.releaseCause as CredentialReleaseCause,
    ...(launchId ? { launchId } : {}),
  };
}
