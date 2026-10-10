import { createFileRoute } from "@tanstack/react-router";
import { validateWeeklyReportMemoryCommand } from "@lrm/coforge-sdk/internal";

import { AppError } from "#src/lib/app-error";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { agentRouteDomainErrorResponse } from "#src/server/agents/agent-http-routes.server";
import { applyWeeklyReportMemoryWriteBack } from "#src/server/records/weekly-report-memory-settlement.server";

export type WeeklyReportMemoryPrincipal = { workspaceId: string; agentId?: string };

/** The records-domain write-back the route dispatches to, without the database handle. */
export type WeeklyReportMemoryService = (
  input: Parameters<typeof applyWeeklyReportMemoryWriteBack>[1],
) => ReturnType<typeof applyWeeklyReportMemoryWriteBack>;

/** Exported and taking its service as an argument so the route's own contract — above all that the
 * response echoes the request's `idempotencyKey`, which the daemon rejects it without — is testable
 * without a database. */
export async function handleWeeklyReportMemoryPost(
  request: Request,
  principal: WeeklyReportMemoryPrincipal,
  service: WeeklyReportMemoryService,
): Promise<Response> {
  try {
    if (!principal.agentId) {
      return Response.json({ error: "agent required" }, { status: 403 });
    }
    const json = (await request.json()) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new AppError("INVALID_INPUT");
    }
    const body = validateWeeklyReportMemoryCommand(json as Record<string, unknown>);
    if (!body) throw new AppError("INVALID_INPUT");
    const result = await service({
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      reportId: body.reportId,
      settlement: {
        year: body.year,
        week: body.week,
        preferences: body.preferences,
        explicitRules: body.explicitRules,
        factCorrections: body.factCorrections,
        threads: body.threads,
      },
    });
    // The daemon rejects the proxy response unless `idempotencyKey` echoes the request.
    return Response.json({
      idempotencyKey: body.idempotencyKey,
      reportId: result.reportId,
      status: result.status,
    });
  } catch (error) {
    return agentRouteDomainErrorResponse(error, "invalid memory request");
  }
}

export const Route = createFileRoute("/api/agent/v1/weekly-report-memory")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleWeeklyReportMemoryPost(request, principal, (input) =>
          applyWeeklyReportMemoryWriteBack(db, input),
        ),
    },
  },
});
