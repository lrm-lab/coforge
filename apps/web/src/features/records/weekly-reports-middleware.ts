import { createMiddleware } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { requireWeeklyReports } from "#src/server/records/weekly-reports-gate.server";

export const weeklyReportsMiddleware = createMiddleware({ type: "function" })
  .middleware([workspaceUserMiddleware])
  .server(async ({ next, context }) => {
    await requireWeeklyReports(context.db, context.workspaceId);
    return next();
  });
