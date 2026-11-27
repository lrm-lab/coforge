import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { EXPERIMENTS, Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { ensureWeeklyReportAssistant } from "./weekly-report-assistant.server";

type Db = PrismaClient | Prisma.TransactionClient;

export function isWeeklyReportsEnabled(db: Db, workspaceId: string) {
  return new Experiments(
    new PrismaExperimentsRepository(db as PrismaClient),
    isFeatureEnabled,
  ).enabled("weeklyReports", { workspaceId });
}

export async function requireWeeklyReports(db: Db, workspaceId: string) {
  if (!(await isWeeklyReportsEnabled(db, workspaceId))) throw new AppError("ACCESS_DENIED");
}

export async function weeklyReportsDisabledResponse(
  db: Db,
  workspaceId: string,
): Promise<Response | undefined> {
  if (await isWeeklyReportsEnabled(db, workspaceId)) return undefined;
  return Response.json({ error: "weekly reports disabled" }, { status: 403 });
}

export function isWeeklyReportsEnabledInValue(experiments: unknown): boolean {
  if (experiments && typeof experiments === "object" && !Array.isArray(experiments)) {
    const value = (experiments as Record<string, unknown>).weeklyReports;
    if (typeof value === "boolean") return value;
  }
  return EXPERIMENTS.weeklyReports.defaultEnabled;
}

export function isWeeklyReportAgentBlocked(
  agent: {
    weeklyReportAssistant?: unknown;
    weeklyReportCollectorBinding?: unknown;
  },
  experiments: unknown,
): boolean {
  return (
    Boolean(agent.weeklyReportAssistant || agent.weeklyReportCollectorBinding) &&
    !isWeeklyReportsEnabledInValue(experiments)
  );
}

export function weeklyReportsAgentFilter(experiments: unknown): Prisma.AgentWhereInput {
  return isWeeklyReportsEnabledInValue(experiments)
    ? {}
    : { weeklyReportAssistant: null, weeklyReportCollectorBinding: null };
}

export async function ensureWeeklyReportAssistantIfEnabled(
  db: PrismaClient,
  input: Parameters<typeof ensureWeeklyReportAssistant>[1],
) {
  if (!(await isWeeklyReportsEnabled(db, input.workspaceId))) return undefined;
  return ensureWeeklyReportAssistant(db, input);
}

export const WEEKLY_REPORTS_VISIBLE_AGENT_WHERE: Prisma.AgentWhereInput = {
  OR: [
    { weeklyReportAssistant: null, weeklyReportCollectorBinding: null },
    { workspace: { experiments: { path: ["weeklyReports"], equals: true } } },
  ],
};

export function weeklyReportsVisibleAgentSql(agentAlias: Prisma.Sql) {
  return Prisma.sql`(
    (
      NOT EXISTS (SELECT 1 FROM "weekly_report_assistants" wra WHERE wra."agentId" = ${agentAlias}."id")
      AND NOT EXISTS (SELECT 1 FROM "weekly_report_collector_bindings" wrcb WHERE wrcb."collectorAgentId" = ${agentAlias}."id")
    )
    OR EXISTS (
      SELECT 1 FROM "workspaces" w
      WHERE w."id" = ${agentAlias}."workspaceId"
        AND COALESCE(NULLIF(w."experiments"->'weeklyReports', 'null'::jsonb), ${JSON.stringify(EXPERIMENTS.weeklyReports.defaultEnabled)}::jsonb) = 'true'::jsonb
    )
  )`;
}
