import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";

// The weekly report collector's server functions: the viewer's Computers it can read from, and its
// collect runs.

export const listWeeklyReportCollectorSlots = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const { loadCollectPlanSlots } =
      await import("#src/server/records/weekly-report-collect-orchestrate.server");
    return loadCollectPlanSlots(db, { workspaceId, userId: user.id });
  });

export const ensureWeeklyReportCollector = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
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
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      windowKind: z.enum(["week", "month", "quarter", "year", "custom"]),
      year: z.number().int().optional(),
      week: z.number().int().optional(),
      month: z.number().int().optional(),
      quarter: z.number().int().optional(),
      customStart: z.string().optional(),
      customEnd: z.string().optional(),
      computers: z
        .array(
          z.object({
            computerId: z.uuid(),
            scanPaths: z.array(z.string()),
          }),
        )
        .min(1),
    }),
  )
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
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ runId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { getCollectRunWithPacks } =
      await import("#src/server/records/weekly-report-collect-run.server");
    return getCollectRunWithPacks(db, {
      workspaceId,
      userId: user.id,
      runId: data.runId,
    });
  });
