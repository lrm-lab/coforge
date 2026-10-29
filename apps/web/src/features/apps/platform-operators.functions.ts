import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { AppError } from "#src/lib/app-error";
import {
  parseOperatorEntry,
  PlatformOperators,
  type PlatformOperatorRow,
} from "#src/server/app-marketplace/platform-operators.server";

/**
 * The review page's "Reviewers" section (`server/app-marketplace/platform-operators.server.ts`):
 * a platform operator lists the others, adds one by a verified email or phone number, and removes
 * one. Thin wrappers; the module decides who may do what, and the last operator cannot be removed.
 */

/** Every platform operator. Operators only; ACCESS_DENIED for anyone else. */
export const loadPlatformOperators = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }): Promise<PlatformOperatorRow[]> => {
    declareNoStore();
    const rows = await new PlatformOperators(context.db).list(context.user.id);
    if (!rows) throw new AppError("ACCESS_DENIED");
    return rows;
  });

/** Why the reviewers section could not add or remove someone. */
export type PlatformOperatorProblem =
  | "invalid_address"
  | "no_user"
  | "ambiguous"
  | "last"
  | "missing"
  | "not_operator"
  | "failed";

const entryInput = z.object({ entry: z.string().trim().min(1).max(320) }).strict();

/** Adds the operator the typed address names. `problem` says why nothing was added. */
export const addPlatformOperator = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(entryInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const entry = parseOperatorEntry(data.entry);
    if (!entry) return { ok: false as const, problem: "invalid_address" as const };
    const outcome = await new PlatformOperators(context.db).grant(context.user.id, entry);
    return outcome === "granted" || outcome === "already"
      ? { ok: true as const }
      : { ok: false as const, problem: outcome as PlatformOperatorProblem };
  });

/** Removes an operator. `last` is the refusal that keeps the list from going empty. */
export const removePlatformOperator = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ userId: z.uuid() }).strict())
  .handler(async ({ data, context }) => {
    declareNoStore();
    const outcome = await new PlatformOperators(context.db).revoke(context.user.id, data.userId);
    return outcome === "revoked"
      ? { ok: true as const }
      : { ok: false as const, problem: outcome as PlatformOperatorProblem };
  });
