import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonHoldRequestSchema,
  DaemonHoldResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";

/**
 * Runner hold. `daemon:hold` tells a daemon to stop admitting new Agent turns and report which
 * Agents are still busy; `daemon:release` lifts it. Both are idempotent, and neither is persisted,
 * so a restarted daemon is never born held.
 */
export type DaemonHoldRequest = {
  protocolMajor: number;
  requestId: string;
  expectedServerUrl: string;
  /** Required by a hold, which the daemon refuses without one. A release names none. */
  reason?: RunnerHoldReason;
};

/**
 * Why a runner hold was asked for. A hold precedes a deliberate restart, so a Workspace daemon that
 * shuts down while held names the matching reason in its shutdown notice. A Computer upgrade is not
 * a hold: the installer's recovery journal is what names it.
 */
export const RUNNER_HOLD_REASONS = {
  /** The Coordinator restarting one Workspace daemon. */
  WORKSPACE_RESTART: "restart",
  /** `coforge-computer restart` restarting the whole Coordinator. */
  COMPUTER_RESTART: "restart-supervisor",
} as const;
export type RunnerHoldReason = (typeof RUNNER_HOLD_REASONS)[keyof typeof RUNNER_HOLD_REASONS];

export function isRunnerHoldReason(value: unknown): value is RunnerHoldReason {
  return Object.values(RUNNER_HOLD_REASONS).some((reason) => reason === value);
}

/** One Agent whose last emitted Activity is still a busy detail kind. */
export type HeldBusyAgent = {
  workspaceId: string;
  agentId: string;
  detailKind: string;
  busySinceMs: number;
};

export type DaemonHoldResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  held: boolean;
  busyAgents: HeldBusyAgent[];
  /** Workspaces that did not answer in time; a Coordinator reports rather than blocks on them. */
  unreachableWorkspaceIds: string[];
};

export function encodeDaemonHoldRequest(value: DaemonHoldRequest): Uint8Array {
  return toBinary(DaemonHoldRequestSchema, create(DaemonHoldRequestSchema, value));
}

export function decodeDaemonHoldRequest(bytes: Uint8Array): DaemonHoldRequest {
  const value = fromBinary(DaemonHoldRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    expectedServerUrl: value.expectedServerUrl,
    reason: isRunnerHoldReason(value.reason) ? value.reason : undefined,
  };
}

export function encodeDaemonHoldResponse(value: DaemonHoldResponse): Uint8Array {
  return toBinary(
    DaemonHoldResponseSchema,
    create(DaemonHoldResponseSchema, {
      ...value,
      busyAgents: value.busyAgents.map((agent) => ({
        ...agent,
        busySinceMs: BigInt(agent.busySinceMs),
      })),
    }),
  );
}

export function decodeDaemonHoldResponse(bytes: Uint8Array): DaemonHoldResponse {
  const value = fromBinary(DaemonHoldResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    accepted: value.accepted,
    held: value.held,
    busyAgents: value.busyAgents.map((agent) => ({
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      detailKind: agent.detailKind,
      busySinceMs: Number(agent.busySinceMs),
    })),
    unreachableWorkspaceIds: [...value.unreachableWorkspaceIds],
  };
}
