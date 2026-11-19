import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  RuntimeManageRequestSchema,
  RuntimeManageResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/runtime_manage_pb";
import { RPC_METHODS } from "./rpc-methods";

export const RUNTIME_MANAGE_CAPABILITY = "runtime-manage:v1" as const;
export const RUNTIME_MANAGE_RESULT_METHOD = RPC_METHODS.daemonRuntimeManageResult;

export const RUNTIME_MANAGE_MIN_TIMEOUT_MS = 10_000;
export const RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS = 300_000;
export const RUNTIME_MANAGE_MAX_TIMEOUT_MS = 600_000;
export const RUNTIME_MANAGE_DIAGNOSTIC_MAX_CHARS = 512;
export const RUNTIME_MANAGE_MAX_STEPS = 8;
export const RUNTIME_MANAGE_STEP_MAX_CHARS = 256;

export const RUNTIME_MANAGE_ACTIONS = ["plan", "install", "upgrade"] as const;
export type RuntimeManageAction = (typeof RUNTIME_MANAGE_ACTIONS)[number];

export const RUNTIME_MANAGE_STATUSES = [
  "planned",
  "installed",
  "already_installed",
  "upgraded",
  "unchanged",
  "not_installed",
  "unsupported",
  "failed",
  "error",
] as const;
export type RuntimeManageStatus = (typeof RUNTIME_MANAGE_STATUSES)[number];

export const RUNTIME_MANAGE_SOURCES = ["npm", "homebrew", "native"] as const;
export type RuntimeManageSource = (typeof RUNTIME_MANAGE_SOURCES)[number];

export const RUNTIME_MANAGE_REASONS = [
  "in_progress",
  "timeout",
  "cancelled",
  "unsupported_provider",
  "unsupported_installation",
  "managed_by_app_bundle",
  "missing_package_manager",
  "command_failed",
  "internal",
] as const;
export type RuntimeManageReason = (typeof RUNTIME_MANAGE_REASONS)[number];

const REQUEST_TYPE = "coforge.rpc.v1.RuntimeManageRequest";
const RESULT_TYPE = "coforge.rpc.v1.RuntimeManageResult";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_ID = /^rtm_[A-Za-z0-9_-]{16,64}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_STRING = /^[^\0\r\n]{1,128}$/;

const ACTIONS = new Set<string>(RUNTIME_MANAGE_ACTIONS);
const STATUSES = new Set<string>(RUNTIME_MANAGE_STATUSES);
const SOURCES = new Set<string>(RUNTIME_MANAGE_SOURCES);
const REASONS = new Set<string>(RUNTIME_MANAGE_REASONS);

export type RuntimeManageRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  provider: string;
  action: RuntimeManageAction;
  requestedByUserId: string;
  timeoutMs: number;
};

export type RuntimeManageResult = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  provider: string;
  action: RuntimeManageAction;
  requestedByUserId: string;
  status: RuntimeManageStatus;
  reason?: RuntimeManageReason;
  source?: RuntimeManageSource;
  steps?: string[];
  previousVersion?: string;
  currentVersion?: string;
  exitCode?: number;
  diagnostic?: string;
  durationMs: number;
};

export function isRuntimeManageRequestId(value: string): boolean {
  return REQUEST_ID.test(value) && !value.includes("\0");
}

function assertPattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value) || value.includes("\0")) {
    throw new Error(`Invalid runtime manage ${label}`);
  }
}

function validateTimeoutMs(timeoutMs: number): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < RUNTIME_MANAGE_MIN_TIMEOUT_MS ||
    timeoutMs > RUNTIME_MANAGE_MAX_TIMEOUT_MS
  ) {
    throw new Error("Invalid runtime manage timeout");
  }
}

function validateRequest(request: RuntimeManageRequest): void {
  if (request.protocolMajor !== 1) throw new Error("Unsupported runtime manage protocol major");
  assertPattern(request.requestId, REQUEST_ID, "request id");
  assertPattern(request.workspaceId, ID, "workspace id");
  assertPattern(request.computerId, ID, "computer id");
  assertPattern(request.provider, PROVIDER_ID, "provider");
  if (!ACTIONS.has(request.action)) throw new Error("Invalid runtime manage action");
  assertPattern(request.requestedByUserId, ID, "requested by user id");
  validateTimeoutMs(request.timeoutMs);
}

const latin1Decoder = new TextDecoder("latin1");

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validateResult(result: RuntimeManageResult): void {
  if (result.protocolMajor !== 1) throw new Error("Unsupported runtime manage protocol major");
  assertPattern(result.requestId, REQUEST_ID, "request id");
  assertPattern(result.workspaceId, ID, "workspace id");
  assertPattern(result.computerId, ID, "computer id");
  assertPattern(result.provider, PROVIDER_ID, "provider");
  if (!ACTIONS.has(result.action)) throw new Error("Invalid runtime manage action");
  assertPattern(result.requestedByUserId, ID, "requested by user id");
  if (!STATUSES.has(result.status)) throw new Error("Invalid runtime manage status");
  if (result.reason !== undefined && !REASONS.has(result.reason)) {
    throw new Error("Invalid runtime manage reason");
  }
  if (result.source !== undefined && !SOURCES.has(result.source)) {
    throw new Error("Invalid runtime manage source");
  }
  if (result.steps !== undefined) {
    if (result.steps.length > RUNTIME_MANAGE_MAX_STEPS) {
      throw new Error("Too many runtime manage steps");
    }
    for (const step of result.steps) {
      if (
        hasControlChar(step) ||
        step.length === 0 ||
        step.length > RUNTIME_MANAGE_STEP_MAX_CHARS
      ) {
        throw new Error("Invalid runtime manage step");
      }
    }
  }
  if (result.previousVersion !== undefined) {
    assertPattern(result.previousVersion, VERSION_STRING, "previous version");
  }
  if (result.currentVersion !== undefined) {
    assertPattern(result.currentVersion, VERSION_STRING, "current version");
  }
  if (
    result.exitCode !== undefined &&
    (!Number.isInteger(result.exitCode) ||
      result.exitCode < -2_147_483_648 ||
      result.exitCode > 2_147_483_647)
  ) {
    throw new Error("Invalid runtime manage exit code");
  }
  if (
    result.diagnostic !== undefined &&
    (hasControlChar(result.diagnostic) ||
      result.diagnostic.length > RUNTIME_MANAGE_DIAGNOSTIC_MAX_CHARS)
  ) {
    throw new Error("Invalid runtime manage diagnostic");
  }
  if (
    !Number.isInteger(result.durationMs) ||
    result.durationMs < 0 ||
    result.durationMs > 4_294_967_295
  ) {
    throw new Error("Invalid runtime manage duration");
  }
}

export function encodeRuntimeManageRequest(request: RuntimeManageRequest): Uint8Array {
  validateRequest(request);
  return toBinary(
    RuntimeManageRequestSchema,
    create(RuntimeManageRequestSchema, {
      protocolMajor: request.protocolMajor,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      provider: request.provider,
      action: request.action,
      requestedByUserId: request.requestedByUserId,
      timeoutMs: request.timeoutMs,
      messageType: REQUEST_TYPE,
    }),
  );
}

export function isRuntimeManageRequest(bytes: Uint8Array): boolean {
  try {
    return fromBinary(RuntimeManageRequestSchema, bytes).messageType === REQUEST_TYPE;
  } catch {
    return latin1Decoder.decode(bytes).includes(REQUEST_TYPE);
  }
}

export function decodeRuntimeManageRequest(bytes: Uint8Array): RuntimeManageRequest {
  const raw = fromBinary(RuntimeManageRequestSchema, bytes);
  if (raw.messageType !== REQUEST_TYPE) throw new Error("Unexpected runtime manage request type");
  const request: RuntimeManageRequest = {
    protocolMajor: raw.protocolMajor,
    requestId: raw.requestId,
    workspaceId: raw.workspaceId,
    computerId: raw.computerId,
    provider: raw.provider,
    action: raw.action as RuntimeManageAction,
    requestedByUserId: raw.requestedByUserId,
    timeoutMs: raw.timeoutMs,
  };
  validateRequest(request);
  return request;
}

export function encodeRuntimeManageResult(result: RuntimeManageResult): Uint8Array {
  validateResult(result);
  return toBinary(
    RuntimeManageResultSchema,
    create(RuntimeManageResultSchema, {
      protocolMajor: result.protocolMajor,
      requestId: result.requestId,
      workspaceId: result.workspaceId,
      computerId: result.computerId,
      provider: result.provider,
      action: result.action,
      requestedByUserId: result.requestedByUserId,
      status: result.status,
      reason: result.reason ?? "",
      source: result.source ?? "",
      steps: result.steps ?? [],
      previousVersion: result.previousVersion ?? "",
      currentVersion: result.currentVersion ?? "",
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      diagnostic: result.diagnostic ?? "",
      durationMs: result.durationMs,
      messageType: RESULT_TYPE,
    }),
  );
}

export function decodeRuntimeManageResult(bytes: Uint8Array): RuntimeManageResult {
  const raw = fromBinary(RuntimeManageResultSchema, bytes);
  if (raw.messageType !== RESULT_TYPE) throw new Error("Unexpected runtime manage result type");
  const result: RuntimeManageResult = {
    protocolMajor: raw.protocolMajor,
    requestId: raw.requestId,
    workspaceId: raw.workspaceId,
    computerId: raw.computerId,
    provider: raw.provider,
    action: raw.action as RuntimeManageAction,
    requestedByUserId: raw.requestedByUserId,
    status: raw.status as RuntimeManageStatus,
    ...(raw.reason ? { reason: raw.reason as RuntimeManageReason } : {}),
    ...(raw.source ? { source: raw.source as RuntimeManageSource } : {}),
    ...(raw.steps.length > 0 ? { steps: [...raw.steps] } : {}),
    ...(raw.previousVersion ? { previousVersion: raw.previousVersion } : {}),
    ...(raw.currentVersion ? { currentVersion: raw.currentVersion } : {}),
    ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
    ...(raw.diagnostic ? { diagnostic: raw.diagnostic } : {}),
    durationMs: raw.durationMs,
  };
  validateResult(result);
  return result;
}
