import {
  MACHINE_DISK_STATUS_METHOD,
  MACHINE_MEMORY_STATUS_METHOD,
  decodeMachineDiskStatusReport,
  decodeMachineMemoryStatusReport,
  type MachineStatusReport,
} from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  PrismaComputerMachineStatusStore,
  type MachineStatusKind,
} from "#src/server/computers/computer-machine-status.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/**
 * A Computer's own report of what it has left (`daemon:v1:machine:disk_status` and
 * `daemon:v1:machine:memory_status`). Only the connection's own Computer may report; a sample
 * that does not add up is refused, and a report older than the stored one is accepted and dropped.
 */
export function createMachineStatusMethod(
  kind: MachineStatusKind,
  store: Pick<PrismaComputerMachineStatusStore, "record">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const rejection = rejectNonDaemonPrincipal(metadata.principal);
    if (rejection) return rejection;
    let report: MachineStatusReport;
    try {
      report =
        kind === "disk"
          ? decodeMachineDiskStatusReport(payload)
          : decodeMachineMemoryStatusReport(payload);
    } catch {
      return { code: 400, message: "invalid machine status report" };
    }
    if (
      metadata.principal.workspaceId !== report.workspaceId ||
      metadata.principal.computerId !== report.computerId
    )
      return { code: 403, message: "machine status report is not authorized" };
    try {
      await store.record(kind, report.computerId, report);
    } catch {
      return { code: 503, message: "machine status report was not recorded" };
    }
    return new Uint8Array();
  };
}

/** What a daemon reports about its own machine, or the 503 stubs without a database. */
export function machineStatusMethods(db: PrismaClient | null): Record<string, CentrifugoRpcMethod> {
  const unavailable: CentrifugoRpcMethod = () => ({
    code: 503,
    message: "protocol method dependencies are unavailable",
  });
  const store = db ? new PrismaComputerMachineStatusStore(db) : undefined;
  return {
    [MACHINE_DISK_STATUS_METHOD]: store ? createMachineStatusMethod("disk", store) : unavailable,
    [MACHINE_MEMORY_STATUS_METHOD]: store
      ? createMachineStatusMethod("memory", store)
      : unavailable,
  };
}
