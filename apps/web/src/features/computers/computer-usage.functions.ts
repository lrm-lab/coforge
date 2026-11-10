import { createServerFn } from "@tanstack/react-start";
import {
  consumeResetCreditInputSchema,
  readResetCreditInputSchema,
  readUsageInputSchema,
  scanUsageInputSchema,
} from "./computer.schemas";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { userRuntimeUsage } from "#src/server/computers/runtime-usage-composition.server";
import { userRuntimeResetCredit } from "#src/server/computers/runtime-reset-credit-composition.server";

/** Asks the Computer to scan one runtime's usage; the answer arrives through `readUsage`. Allowed
 * to whoever may sign the runtime in or out (`RuntimeUsageAccess`). */
export const scanUsage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(scanUsageInputSchema)
  .handler(({ context, data }) =>
    userRuntimeUsage(context.db).scan(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    ),
  );

/** The cached usage result for one runtime; readable while a scan is still running. */
export const readUsage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readUsageInputSchema)
  .handler(({ context, data }) =>
    userRuntimeUsage(context.db).read(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    ),
  );

/**
 * Starts spending one reset credit of the account a runtime is signed in to, and returns at once
 * with the request to read the answer by: production closes a request idle for about ten seconds,
 * and the Computer can take longer. Allowed to the same people as `scanUsage`: who may sign the
 * runtime in or out. A refusal comes back as a value, never thrown, so the page can tell it from
 * a failure. The fresh usage reaches the popover through the usage cache.
 */
export const consumeResetCredit = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(consumeResetCreditInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return userRuntimeResetCredit(context.db).start(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    );
  });

/** The Computer's answer to a started attempt: pending, or what it settled. Allowed to the same
 * people as the start, on every read. */
export const readResetCredit = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readResetCreditInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return userRuntimeResetCredit(context.db).read(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    );
  });
