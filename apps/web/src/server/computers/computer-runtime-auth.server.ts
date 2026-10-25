import {
  sanitizeRuntimeAuthStatus,
  type RuntimeAuthProvider,
  type RuntimeAuthStatus,
} from "@lrm/coforge-anvil";
import type { PrismaClient } from "#src/generated/prisma/client";

/**
 * A Computer's newest runtime login report as stored in `computers.runtimeAuth`: one status per
 * runtime with a login flow, by provider. Every status went through `sanitizeRuntimeAuthStatus`
 * on the Computer and again here, so an account label is always short and visibly masked.
 */
export type StoredRuntimeAuth = {
  collectedAtMs: number;
  runtimes: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>>;
};

/** A report's statuses, sanitized and keyed by provider; a provider without a login flow is dropped. */
export function storedRuntimeAuth(
  collectedAtMs: number,
  statuses: readonly unknown[],
): StoredRuntimeAuth {
  const runtimes: StoredRuntimeAuth["runtimes"] = {};
  for (const value of statuses) {
    const status = sanitizeRuntimeAuthStatus(value);
    if (status) runtimes[status.provider] = status;
  }
  return { collectedAtMs, runtimes };
}

/** The stored column read back, sanitized once more; anything that is not a report is nothing. */
export function parseStoredRuntimeAuth(value: unknown): StoredRuntimeAuth | null {
  if (typeof value !== "object" || value === null) return null;
  const { collectedAtMs, runtimes } = value as { collectedAtMs?: unknown; runtimes?: unknown };
  if (!Number.isSafeInteger(collectedAtMs) || typeof runtimes !== "object" || runtimes === null)
    return null;
  return storedRuntimeAuth(collectedAtMs as number, Object.values(runtimes));
}

/**
 * What one viewer may see of a Computer's login statuses, by provider, for the runtimes they may
 * see. Only someone who may sign its runtimes in or out (the Computer's owner, a Workspace owner
 * or admin) sees the account; everyone else gets the state alone, and the account is absent from
 * the data, not hidden.
 */
export function runtimeAuthView(
  column: unknown,
  viewer: { showAccount: boolean; visibleProviders: readonly string[] },
): Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>> {
  const view: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>> = {};
  for (const status of Object.values(parseStoredRuntimeAuth(column)?.runtimes ?? {})) {
    if (!viewer.visibleProviders.includes(status.provider)) continue;
    const { provider, state, unavailableReason } = status;
    view[provider] = viewer.showAccount
      ? status
      : { provider, state, ...(unavailableReason ? { unavailableReason } : {}) };
  }
  return view;
}

/** Writes a Computer's report unless the stored one was collected later. */
export class PrismaComputerRuntimeAuthStore {
  constructor(private readonly db: Pick<PrismaClient, "$executeRaw">) {}

  /** `false` when the stored report is newer (or the Computer is gone), so nothing changed. */
  async record(computerId: string, auth: StoredRuntimeAuth): Promise<boolean> {
    const updated = await this.db.$executeRaw`
      UPDATE "computers" SET "runtimeAuth" = ${JSON.stringify(auth)}::jsonb
      WHERE "id" = ${computerId}::uuid
        AND ("runtimeAuth" IS NULL
          OR ("runtimeAuth"->>'collectedAtMs')::bigint < ${auth.collectedAtMs})`;
    return updated > 0;
  }
}
