import type { DatabaseScope } from "#src/server/db/transaction.server";
import { AppError } from "#src/lib/app-error";

/** Whether the account has AI Workbench on. NULL, a person who never chose, is off. */
export async function isAiWorkbenchEnabled(db: DatabaseScope, userId: string) {
  const row = await db.userPreference.findUnique({
    where: { userId },
    select: { aiWorkbenchEnabled: true },
  });
  return row?.aiWorkbenchEnabled === true;
}

/** Refuses an account whose AI Workbench switch is off; every Workbench entry calls it. */
export async function requireAiWorkbench(db: DatabaseScope, userId: string) {
  if (!(await isAiWorkbenchEnabled(db, userId))) throw new AppError("ACCESS_DENIED");
}
