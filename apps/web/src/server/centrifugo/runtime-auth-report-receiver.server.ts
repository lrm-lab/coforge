import {
  RUNTIME_AUTH_STATUS_REPORT_METHOD,
  DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
  decodeRuntimeAuthStatusReport,
  type RuntimeAuthStatusReport,
} from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  PrismaComputerRuntimeAuthStore,
  runtimeAuthChangeAnnouncer,
  storedRuntimeAuth,
} from "#src/server/computers/computer-runtime-auth.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import { createCentrifugoServerApi } from "./server-api.server";
import {
  createDaemonRuntimeCodeAgentsUpdateMethod,
  type CentrifugoRpcMethod,
} from "./rpc-handler.server";

/**
 * A Computer's runtime login report (`daemon:v1:runtime_auth:status_report`). Only the connection's own
 * Computer may report; each status is sanitized again before it is stored, and a report older
 * than the stored one is accepted and dropped. A stored one is announced to whoever may be showing
 * the Computer; a lost announcement waits for their next read and does not fail the report.
 */
export function createRuntimeAuthReportMethod(
  store: Pick<PrismaComputerRuntimeAuthStore, "record">,
  announce: (computerId: string) => Promise<void>,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const rejection = rejectNonDaemonPrincipal(metadata.principal);
    if (rejection) return rejection;
    let report: RuntimeAuthStatusReport;
    try {
      report = decodeRuntimeAuthStatusReport(payload);
    } catch {
      return { code: 400, message: "invalid runtime auth status report" };
    }
    if (
      metadata.principal.workspaceId !== report.workspaceId ||
      metadata.principal.computerId !== report.computerId
    )
      return { code: 403, message: "runtime auth status report is not authorized" };
    let auth: ReturnType<typeof storedRuntimeAuth>;
    try {
      auth = storedRuntimeAuth(report.collectedAtMs, report.runtimes);
    } catch {
      return { code: 400, message: "invalid runtime auth status report" };
    }
    let stored: boolean;
    try {
      stored = await store.record(report.computerId, auth);
    } catch {
      return { code: 503, message: "runtime auth status report was not recorded" };
    }
    // The daemon does not wait on it: the report is stored either way.
    if (stored) void announce(report.computerId).catch(() => {});
    return new Uint8Array();
  };
}

/** What a daemon reports about its Computer's runtimes, or the 503 stubs without a database. */
export function computerRuntimeMethods(
  db: PrismaClient | null,
): Record<string, CentrifugoRpcMethod> {
  const unavailable: CentrifugoRpcMethod = () => ({
    code: 503,
    message: "protocol method dependencies are unavailable",
  });
  return {
    [DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD]: db
      ? createDaemonRuntimeCodeAgentsUpdateMethod(new PrismaComputerRuntimeRepository(db))
      : unavailable,
    [RUNTIME_AUTH_STATUS_REPORT_METHOD]: db
      ? createRuntimeAuthReportMethod(
          new PrismaComputerRuntimeAuthStore(db),
          runtimeAuthChangeAnnouncer(db, createCentrifugoServerApi()),
        )
      : unavailable,
  };
}
