import {
  decodeRuntimeAuthLoginReport,
  decodeRuntimeAuthLogoutReport,
  RUNTIME_AUTH_LOGIN_REPORT_METHOD,
  RUNTIME_AUTH_LOGOUT_REPORT_METHOD,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { userRuntimeAuth } from "#src/server/computers/runtime-auth-composition.server";
import type { RuntimeAuth } from "#src/server/computers/runtime-auth.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

const NOT_AUTHORIZED = { code: 403, message: "Runtime auth report is not authorized" };

/** The daemon's login and sign-out reports: the principal's Computer must be the one reporting. */
export function createRuntimeAuthReportMethods(
  auth: Pick<RuntimeAuth, "receiveLoginReport" | "receiveLogoutReport">,
): Record<string, CentrifugoRpcMethod> {
  const method =
    <T extends { workspaceId: string; computerId: string }>(
      decode: (payload: Uint8Array) => T,
      receive: (scope: { workspaceId: string; computerId: string }, report: T) => Promise<boolean>,
    ): CentrifugoRpcMethod =>
    async (payload, metadata) => {
      const rejection = rejectNonDaemonPrincipal(metadata.principal);
      if (rejection) return rejection;
      let report: T;
      try {
        report = decode(payload);
      } catch {
        return NOT_AUTHORIZED;
      }
      if (
        metadata.principal.workspaceId !== report.workspaceId ||
        metadata.principal.computerId !== report.computerId
      )
        return NOT_AUTHORIZED;
      try {
        if (!(await receive(metadata.principal, report))) return NOT_AUTHORIZED;
      } catch {
        return { code: 503, message: "Runtime auth report could not be stored" };
      }
      return new Uint8Array();
    };
  return {
    [RUNTIME_AUTH_LOGIN_REPORT_METHOD]: method(decodeRuntimeAuthLoginReport, (scope, report) =>
      auth.receiveLoginReport(scope, report),
    ),
    [RUNTIME_AUTH_LOGOUT_REPORT_METHOD]: method(decodeRuntimeAuthLogoutReport, (scope, report) =>
      auth.receiveLogoutReport(scope, report),
    ),
  };
}

/** The report methods, or the 503 stub when the server composes without a database. */
export function runtimeAuthMethods(db: PrismaClient | null): Record<string, CentrifugoRpcMethod> {
  if (db) return createRuntimeAuthReportMethods(userRuntimeAuth(db));
  const unavailable: CentrifugoRpcMethod = () => ({
    code: 503,
    message: "protocol method dependencies are unavailable",
  });
  return {
    [RUNTIME_AUTH_LOGIN_REPORT_METHOD]: unavailable,
    [RUNTIME_AUTH_LOGOUT_REPORT_METHOD]: unavailable,
  };
}
