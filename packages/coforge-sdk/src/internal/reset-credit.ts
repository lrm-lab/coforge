import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonRuntimeResetCreditConsumeRequestSchema,
  DaemonRuntimeResetCreditConsumeResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import { RPC_METHODS } from "./rpc-methods";
import type { RuntimeProvider } from "./runtime-provider";

/** The daemon takes a request to spend a rate-limit reset credit: a page may offer the action. */
export const RESET_CREDIT_CAPABILITY = "runtime-usage:reset-credit:v1" as const;
export const DAEMON_RUNTIME_RESET_CREDIT_RESULT_METHOD = RPC_METHODS.daemonResetCreditConsumeResult;
export const RESET_CREDIT_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeResetCreditConsumeRequest" as const;
export const RESET_CREDIT_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeResetCreditConsumeResponse" as const;

/** What one attempt settled. `unknown` is the only value that leaves the attempt open: the credit
 * may or may not have been spent, so a retry must carry the same idempotency key. */
export const RESET_CREDIT_OUTCOMES = [
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
  "reauth_required",
  "unsupported",
  "unknown",
] as const;
export type ResetCreditOutcome = (typeof RESET_CREDIT_OUTCOMES)[number];

export const isResetCreditOutcome = (value: unknown): value is ResetCreditOutcome =>
  RESET_CREDIT_OUTCOMES.includes(value as ResetCreditOutcome);

/** The most reset credits an account is shown with; a larger count is not shown at all. */
export const RESET_CREDITS_MAX = 999;

/** One logical attempt's key, as the page makes it (a UUID) and the daemon accepts it. */
export const RESET_CREDIT_IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
export const isResetCreditIdempotencyKey = (value: unknown): value is string =>
  typeof value === "string" && RESET_CREDIT_IDEMPOTENCY_KEY.test(value);

/** Server -> daemon, on the daemon control channel beside the usage scan. */
export type DaemonRuntimeResetCreditConsumeRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  provider: RuntimeProvider;
  idempotencyKey: string;
  messageType?: typeof RESET_CREDIT_MESSAGE_TYPE;
};

/** Daemon -> server. `snapshotJson` is the usage re-read after the attempt, when it succeeded. */
export type DaemonRuntimeResetCreditConsumeResponse = Omit<
  DaemonRuntimeResetCreditConsumeRequest,
  "idempotencyKey" | "messageType"
> & {
  outcome: ResetCreditOutcome;
  snapshotJson?: Uint8Array;
  messageType?: typeof RESET_CREDIT_RESPONSE_MESSAGE_TYPE;
};

export const encodeDaemonRuntimeResetCreditConsumeRequest = (
  value: DaemonRuntimeResetCreditConsumeRequest,
) =>
  toBinary(
    DaemonRuntimeResetCreditConsumeRequestSchema,
    create(DaemonRuntimeResetCreditConsumeRequestSchema, {
      ...value,
      messageType: RESET_CREDIT_MESSAGE_TYPE,
    }),
  );

export function decodeDaemonRuntimeResetCreditConsumeRequest(
  bytes: Uint8Array,
): DaemonRuntimeResetCreditConsumeRequest {
  const value = fromBinary(DaemonRuntimeResetCreditConsumeRequestSchema, bytes);
  if (value.messageType !== RESET_CREDIT_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    provider: value.provider as RuntimeProvider,
    idempotencyKey: value.idempotencyKey,
    messageType: RESET_CREDIT_MESSAGE_TYPE,
  };
}

export const encodeDaemonRuntimeResetCreditConsumeResponse = (
  value: DaemonRuntimeResetCreditConsumeResponse,
) =>
  toBinary(
    DaemonRuntimeResetCreditConsumeResponseSchema,
    create(DaemonRuntimeResetCreditConsumeResponseSchema, {
      ...value,
      messageType: RESET_CREDIT_RESPONSE_MESSAGE_TYPE,
    }),
  );

export function decodeDaemonRuntimeResetCreditConsumeResponse(
  bytes: Uint8Array,
): DaemonRuntimeResetCreditConsumeResponse {
  const value = fromBinary(DaemonRuntimeResetCreditConsumeResponseSchema, bytes);
  if (value.messageType !== RESET_CREDIT_RESPONSE_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  // A required field is validated here, not defaulted: an outcome this build cannot read is no
  // answer, and the page that asked reaches its deadline and shows `unknown`.
  if (!isResetCreditOutcome(value.outcome)) throw new Error("invalid reset credit outcome");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    provider: value.provider as RuntimeProvider,
    outcome: value.outcome,
    ...(value.snapshotJson.length ? { snapshotJson: value.snapshotJson } : {}),
    messageType: RESET_CREDIT_RESPONSE_MESSAGE_TYPE,
  };
}
