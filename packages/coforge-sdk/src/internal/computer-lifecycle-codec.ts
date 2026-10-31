import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ComputerRestartIntentSchema,
  ComputerUpgradeIntentSchema,
  ComputerUpgradeResultSchema,
  type ComputerUpgradeRecovery as UpgradeRecoveryProto,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import { UPGRADE_ERROR_CODE_PATTERN } from "./index";
import type { ComputerRestartIntent, ComputerUpgradeIntent, ComputerUpgradeResult } from "./index";
import {
  COMPUTER_RESTART_MESSAGE_TYPE,
  COMPUTER_UPGRADE_MESSAGE_TYPE,
  COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE,
} from "./index";

export function encodeComputerRestartIntent(value: ComputerRestartIntent): Uint8Array {
  return toBinary(
    ComputerRestartIntentSchema,
    create(ComputerRestartIntentSchema, { ...value, messageType: COMPUTER_RESTART_MESSAGE_TYPE }),
  );
}

export function decodeComputerRestartIntent(bytes: Uint8Array): ComputerRestartIntent {
  const value = fromBinary(ComputerRestartIntentSchema, bytes);
  if (value.messageType !== COMPUTER_RESTART_MESSAGE_TYPE)
    throw new Error("invalid Computer restart message type");
  if (!value.requestId || !value.workspaceId || !value.computerId)
    throw new Error("invalid Computer restart intent");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    messageType: COMPUTER_RESTART_MESSAGE_TYPE,
  };
}

export function encodeComputerUpgradeIntent(value: ComputerUpgradeIntent): Uint8Array {
  return toBinary(
    ComputerUpgradeIntentSchema,
    create(ComputerUpgradeIntentSchema, {
      ...value,
      target: "latest",
      ...(value.expectedVersion ? { expectedVersion: value.expectedVersion } : {}),
      messageType: COMPUTER_UPGRADE_MESSAGE_TYPE,
    }),
  );
}

export function decodeComputerUpgradeIntent(bytes: Uint8Array): ComputerUpgradeIntent {
  const value = fromBinary(ComputerUpgradeIntentSchema, bytes);
  if (
    value.messageType !== COMPUTER_UPGRADE_MESSAGE_TYPE ||
    value.target !== "latest" ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId
  )
    throw new Error("invalid Computer upgrade intent");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    target: "latest",
    ...(value.expectedVersion ? { expectedVersion: value.expectedVersion } : {}),
    messageType: COMPUTER_UPGRADE_MESSAGE_TYPE,
  };
}

/** How much reported failure text the protocol carries. */
const UPGRADE_ERROR_LIMIT = 300;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/)[^\s"'`]{2,}/g;
const SECRET_LIKE = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Upgrade failures are rendered to Workspace members, so the text that leaves the machine must
 * not carry local filesystem layout or anything shaped like a credential. Both ends apply this:
 * the Daemon before it reports, the server before it stores.
 */
export function sanitizeUpgradeErrorText(value: string): string {
  return value
    .replace(ABSOLUTE_PATH, "<path>")
    .replace(SECRET_LIKE, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, UPGRADE_ERROR_LIMIT);
}

function upgradeRecoveryFields(recovery: ComputerUpgradeResult["recovery"]) {
  if (!recovery) return {};
  if (recovery.outcome !== "recovered" && recovery.outcome !== "failed")
    throw new Error("invalid Computer upgrade recovery outcome");
  if (!Number.isSafeInteger(recovery.attempts) || recovery.attempts <= 0)
    throw new Error("invalid Computer upgrade recovery attempts");
  return {
    recovery: {
      outcome: recovery.outcome,
      ...(recovery.restoredVersion ? { restoredVersion: recovery.restoredVersion } : {}),
      attempts: recovery.attempts,
      finishedAtMs: BigInt(Math.trunc(recovery.finishedAtMs)),
      // The same rule as the result's own `error`: recovery text can name local paths.
      ...(recovery.message ? { message: sanitizeUpgradeErrorText(recovery.message) } : {}),
    },
  };
}

export function encodeComputerUpgradeResult(value: ComputerUpgradeResult): Uint8Array {
  if (value.status !== "succeeded" && value.status !== "failed")
    throw new Error("invalid Computer upgrade result status");
  if (value.errorCode !== undefined && !UPGRADE_ERROR_CODE_PATTERN.test(value.errorCode))
    throw new Error("invalid Computer upgrade result error code");
  return toBinary(
    ComputerUpgradeResultSchema,
    create(ComputerUpgradeResultSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      status: value.status,
      completedAtMs: BigInt(Math.trunc(value.completedAtMs)),
      messageType: COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE,
      ...(value.version ? { version: value.version } : {}),
      ...(value.error ? { error: sanitizeUpgradeErrorText(value.error) } : {}),
      ...(value.errorCode ? { errorCode: value.errorCode } : {}),
      ...upgradeRecoveryFields(value.recovery),
    }),
  );
}

export function decodeComputerUpgradeResult(bytes: Uint8Array): ComputerUpgradeResult {
  const value = fromBinary(ComputerUpgradeResultSchema, bytes);
  if (
    value.messageType !== COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    (value.status !== "succeeded" && value.status !== "failed")
  )
    throw new Error("invalid Computer upgrade result");
  const completedAtMs = Number(value.completedAtMs);
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0)
    throw new Error("invalid Computer upgrade result completion time");
  // The shape is enforced (a malformed value is a decode failure); membership in the known
  // vocabulary is not - a newer peer's code this build has not learned about yet must still
  // arrive intact rather than being dropped or rejected.
  if (value.errorCode !== undefined && !UPGRADE_ERROR_CODE_PATTERN.test(value.errorCode))
    throw new Error("invalid Computer upgrade result error code");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    status: value.status,
    completedAtMs,
    ...(value.version ? { version: value.version } : {}),
    ...(value.error ? { error: sanitizeUpgradeErrorText(value.error) } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
    ...upgradeRecoveryResult(value.recovery),
    messageType: COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE,
  };
}

function upgradeRecoveryResult(
  recovery: UpgradeRecoveryProto | undefined,
): Pick<ComputerUpgradeResult, "recovery"> {
  if (!recovery) return {};
  const outcome =
    recovery.outcome === "recovered" || recovery.outcome === "failed"
      ? recovery.outcome
      : undefined;
  const finishedAtMs = Number(recovery.finishedAtMs);
  if (
    outcome === undefined ||
    !Number.isSafeInteger(recovery.attempts) ||
    recovery.attempts <= 0 ||
    !Number.isSafeInteger(finishedAtMs) ||
    finishedAtMs < 0
  )
    throw new Error("invalid Computer upgrade recovery");
  return {
    recovery: {
      outcome,
      ...(recovery.restoredVersion ? { restoredVersion: recovery.restoredVersion } : {}),
      attempts: recovery.attempts,
      finishedAtMs,
      ...(recovery.message ? { message: sanitizeUpgradeErrorText(recovery.message) } : {}),
    },
  };
}
