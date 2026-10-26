import {
  sanitizeRuntimeAuthStatus,
  runtimeAuthAccount,
  type RuntimeAuthProvider,
  type RuntimeAuthStatus,
} from "@lrm/coforge-anvil";
import type { RuntimeAuthReportedState } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";

/**
 * A Computer's newest runtime login report as stored in `computers.runtimeAuth`: one status per
 * provider, including providers a newer daemon supports before this server does. Storage validates
 * the report independently of the display whitelist; reads still filter through Anvil.
 */
export type StoredRuntimeAuth = {
  collectedAtMs: number;
  runtimes: Record<string, RuntimeAuthReportedState>;
};

/** Keep structurally valid states for future providers without retaining arbitrary object fields. */
export function storedRuntimeAuth(
  collectedAtMs: number,
  statuses: readonly unknown[],
): StoredRuntimeAuth {
  if (!Number.isSafeInteger(collectedAtMs) || statuses.length > 32)
    throw new Error("invalid runtime auth status report");
  const runtimes: StoredRuntimeAuth["runtimes"] = {};
  let skippedEntries = 0;
  for (const value of statuses) {
    const status = reportedState(value);
    if (!status) {
      skippedEntries += 1;
      continue;
    }
    if (Object.hasOwn(runtimes, status.provider))
      throw new Error("duplicate runtime auth provider");
    runtimes[status.provider] = status;
  }
  const report = { collectedAtMs, runtimes };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > 16_384)
    throw new Error("runtime auth status report exceeds storage limit");
  if (skippedEntries > 0)
    console.warn(JSON.stringify({ event: "runtime_auth.report_entries_skipped", skippedEntries }));
  return report;
}

function reportedState(value: unknown): RuntimeAuthReportedState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { provider, state, unavailableReason } = record;
  if (typeof provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider))
    return undefined;
  if (state === "logged_in") {
    const account =
      typeof record.account === "object" && record.account !== null ? record.account : {};
    return { provider, state, ...runtimeAuthAccount(account) };
  }
  if (state === "logged_out") return { provider, state };
  if (
    state === "unavailable" &&
    (unavailableReason === "not_installed" ||
      unavailableReason === "version_unsupported" ||
      unavailableReason === "unsupported_installation")
  )
    return { provider, state, unavailableReason };
  return { provider, state: "unknown" };
}

/** Display reads recognize only currently supported providers, sanitized once more. */
export function parseStoredRuntimeAuth(value: unknown): {
  collectedAtMs: number;
  runtimes: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>>;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const { collectedAtMs, runtimes } = value as { collectedAtMs?: unknown; runtimes?: unknown };
  if (!Number.isSafeInteger(collectedAtMs) || typeof runtimes !== "object" || runtimes === null)
    return null;
  const supported: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>> = {};
  for (const entry of Object.values(runtimes)) {
    const status = sanitizeRuntimeAuthStatus(entry);
    if (status) supported[status.provider] = status;
  }
  return { collectedAtMs: collectedAtMs as number, runtimes: supported };
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
