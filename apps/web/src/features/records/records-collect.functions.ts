import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { weeklyReportsMiddleware } from "./weekly-reports-middleware";
import { submitCollectPlanInputSchema } from "./records-schemas";

export const listWeeklyReportCollectorSlots = createServerFn({ method: "GET" })
  .middleware([weeklyReportsMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const { loadCollectPlanSlots } =
      await import("#src/server/records/weekly-report-collect-orchestrate.server");
    return loadCollectPlanSlots(db, { workspaceId, userId: user.id });
  });

export const ensureWeeklyReportCollector = createServerFn({ method: "POST" })
  .middleware([weeklyReportsMiddleware])
  .validator(z.object({ computerId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { ensureCollectPlanCollector } =
      await import("#src/server/records/weekly-report-collect-orchestrate.server");
    return ensureCollectPlanCollector(db, {
      workspaceId,
      userId: user.id,
      computerId: data.computerId,
    });
  });

export const submitWeeklyReportCollectPlan = createServerFn({ method: "POST" })
  .middleware([weeklyReportsMiddleware])
  .validator(submitCollectPlanInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { submitWeeklyReportCollectPlan: submit } =
      await import("#src/server/records/weekly-report-collect-orchestrate.server");
    return submit(db, {
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      windowKind: data.windowKind,
      year: data.year,
      week: data.week,
      month: data.month,
      quarter: data.quarter,
      customStart: data.customStart,
      customEnd: data.customEnd,
      computers: data.computers,
    });
  });

export const loadWeeklyReportCollectRun = createServerFn({ method: "GET" })
  .middleware([weeklyReportsMiddleware])
  .validator(z.object({ runId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { getCollectRunWithPacks } =
      await import("#src/server/records/weekly-report-collect-settlement.server");
    return getCollectRunWithPacks(db, {
      workspaceId,
      userId: user.id,
      runId: data.runId,
    });
  });
