import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  MachineDiskStatusReportSchema,
  MachineMemoryStatusReportSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import { RPC_METHODS } from "./rpc-methods";
import { boundedPayload } from "./bounded-payload";

/** Daemon -> server notices: what this Computer has left to run Agents with. */
export const MACHINE_DISK_STATUS_METHOD = RPC_METHODS.daemonMachineDiskStatus;
export const MACHINE_MEMORY_STATUS_METHOD = RPC_METHODS.daemonMachineMemoryStatus;

/** The ready capability that says this daemon reports machine status at all. */
export const MACHINE_STATUS_CAPABILITY = "machine-status:v1" as const;

export type MachineStatusReport = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  reportedAtMs: number;
  availableBytes: number;
  totalBytes: number;
};

const MAX_REPORT_BYTES = 1_024;

/**
 * Whether a sample is worth sending: a real total, an available figure inside it, and both
 * safe integers. A filesystem or a container that answers nonsense reports nothing rather than
 * a number a person would act on.
 */
export function isMachineStatusReportable(value: {
  availableBytes: number;
  totalBytes: number;
}): boolean {
  return (
    Number.isSafeInteger(value.availableBytes) &&
    Number.isSafeInteger(value.totalBytes) &&
    value.totalBytes > 0 &&
    value.availableBytes >= 0 &&
    value.availableBytes <= value.totalBytes
  );
}

export function encodeMachineDiskStatusReport(value: MachineStatusReport): Uint8Array {
  check(value);
  return boundedPayload(
    toBinary(
      MachineDiskStatusReportSchema,
      create(MachineDiskStatusReportSchema, {
        protocolMajor: value.protocolMajor,
        requestId: value.requestId,
        workspaceId: value.workspaceId,
        computerId: value.computerId,
        reportedAtMs: BigInt(value.reportedAtMs),
        availableBytes: BigInt(value.availableBytes),
        totalBytes: BigInt(value.totalBytes),
      }),
    ),
    MAX_REPORT_BYTES,
    "machine disk status report",
  );
}

export function encodeMachineMemoryStatusReport(value: MachineStatusReport): Uint8Array {
  check(value);
  return boundedPayload(
    toBinary(
      MachineMemoryStatusReportSchema,
      create(MachineMemoryStatusReportSchema, {
        protocolMajor: value.protocolMajor,
        requestId: value.requestId,
        workspaceId: value.workspaceId,
        computerId: value.computerId,
        reportedAtMs: BigInt(value.reportedAtMs),
        availableBytes: BigInt(value.availableBytes),
        totalBytes: BigInt(value.totalBytes),
      }),
    ),
    MAX_REPORT_BYTES,
    "machine memory status report",
  );
}

export function decodeMachineDiskStatusReport(bytes: Uint8Array): MachineStatusReport {
  return decode(fromBinary(MachineDiskStatusReportSchema, bounded(bytes)));
}

export function decodeMachineMemoryStatusReport(bytes: Uint8Array): MachineStatusReport {
  return decode(fromBinary(MachineMemoryStatusReportSchema, bounded(bytes)));
}

function bounded(bytes: Uint8Array): Uint8Array {
  return boundedPayload(bytes, MAX_REPORT_BYTES, "machine status report");
}

function decode(wire: {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  reportedAtMs: bigint;
  availableBytes: bigint;
  totalBytes: bigint;
}): MachineStatusReport {
  const value: MachineStatusReport = {
    protocolMajor: wire.protocolMajor,
    requestId: wire.requestId,
    workspaceId: wire.workspaceId,
    computerId: wire.computerId,
    reportedAtMs: Number(wire.reportedAtMs),
    availableBytes: Number(wire.availableBytes),
    totalBytes: Number(wire.totalBytes),
  };
  check(value);
  return value;
}

function check(value: MachineStatusReport) {
  if (
    value.protocolMajor !== 1 ||
    [value.requestId, value.workspaceId, value.computerId].some(
      (field) => !field.trim() || field.length > 512,
    ) ||
    !Number.isSafeInteger(value.reportedAtMs) ||
    !isMachineStatusReportable(value)
  )
    throw new Error("invalid machine status report");
}
