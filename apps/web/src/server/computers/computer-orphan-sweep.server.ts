import type { PrismaClient } from "#src/generated/prisma/client";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";

/**
 * The orphan Computer sweep (task #417): `computer:register` writes the Computer, its
 * `workspace_computers` link and a live key before the machine's Daemon starts. A start that
 * never happens — the CLI died, the revoke call failed — leaves a record the Computers page
 * shows as "Unknown" forever. A link older than `ORPHAN_MIN_AGE_MS` whose Computer never
 * reported `computerVersion` (the Daemon's first metadata write) is unlinked with its keys
 * revoked and recorded, and the Computer row is deleted once no link or dependent row remains.
 * `COFORGE_ORPHAN_COMPUTER_SWEEP=dry-run` counts the candidates and writes nothing, for the
 * staging check before the sweep is set loose.
 */
export const ORPHAN_MIN_AGE_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;

/** Dependent rows that keep an unlinked Computer row: any of them means the machine did more
 * than register (an Agent placed on it, a runtime report), so the row stays for its owner. */
const BLOCKING_RELATIONS = {
  agents: true,
  agentApiKeys: true,
  agentActivity: true,
  runtimes: true,
  modelCatalogs: true,
  hostJobs: true,
  reminders: true,
  weeklyReportCollectorBindings: true,
  weeklyReportCollectSlots: true,
  migrationsOut: true,
  migrationsIn: true,
} as const;

export type OrphanSweepResult = {
  candidates: number;
  unlinked: number;
  computersDeleted: number;
};

/**
 * Removes every orphan link once, returning the counts. `dryRun` answers what a real run would
 * touch (`candidates`) and writes nothing. Each link is re-checked inside its transaction — a
 * Daemon that connected between the scan and the write sets `computerVersion` and the link is
 * skipped.
 */
export async function sweepOrphanComputerLinks(
  db: Pick<PrismaClient, "workspaceComputer" | "computer" | "$transaction">,
  now: Date = new Date(),
  options: { dryRun?: boolean } = {},
): Promise<OrphanSweepResult> {
  const cutoff = new Date(now.getTime() - ORPHAN_MIN_AGE_MS);
  const links = await db.workspaceComputer.findMany({
    where: {
      createdAt: { lt: cutoff },
      computer: { kind: "local", computerVersion: null },
    },
    select: { workspaceId: true, computerId: true },
  });
  if (options.dryRun) return { candidates: links.length, unlinked: 0, computersDeleted: 0 };

  const result: OrphanSweepResult = { candidates: links.length, unlinked: 0, computersDeleted: 0 };
  for (const link of links) {
    try {
      const outcome = await db.$transaction(async (tx) => {
        const computer = await tx.computer.findUnique({
          where: { id: link.computerId },
          select: {
            kind: true,
            computerVersion: true,
            _count: { select: BLOCKING_RELATIONS },
          },
        });
        const row = await tx.workspaceComputer.findUnique({
          where: {
            workspaceId_computerId: {
              workspaceId: link.workspaceId,
              computerId: link.computerId,
            },
          },
          select: { id: true, createdAt: true },
        });
        if (
          !computer ||
          computer.kind !== "local" ||
          computer.computerVersion !== null ||
          !row ||
          row.createdAt >= cutoff
        )
          return "skipped" as const;
        // Recorded before the revoke and the link delete, while the keys are still live.
        await DaemonCredentialRevocations.recordForComputer(
          tx,
          { workspaceId: link.workspaceId, computerId: link.computerId },
          now,
        );
        await tx.daemonApiKey.updateMany({
          where: {
            workspaceId: link.workspaceId,
            computerId: link.computerId,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        await tx.workspaceComputer.delete({ where: { id: row.id } });
        const remaining = await tx.workspaceComputer.count({
          where: { computerId: link.computerId },
        });
        const blocked = Object.values(computer._count).some((count) => count > 0);
        if (remaining === 0 && !blocked) {
          await DaemonCredentialRevocations.recordForComputerEverywhere(tx, link.computerId, now);
          await tx.computer.delete({ where: { id: link.computerId } });
          return "computer_deleted" as const;
        }
        return "unlinked" as const;
      });
      if (outcome === "unlinked") result.unlinked++;
      if (outcome === "computer_deleted") {
        result.unlinked++;
        result.computersDeleted++;
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "computer_orphan_sweep_item_failed",
          workspace_id: link.workspaceId,
          computer_id: link.computerId,
          error_type: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }
  return result;
}

let sweep: { stop: () => void } | undefined;

/** Starts the hourly sweep once per process, reporting-only while
 * `COFORGE_ORPHAN_COMPUTER_SWEEP=dry-run`. Idempotent like its neighbours. */
export function ensureComputerOrphanSweep(): void {
  if (sweep) return;
  const tick = () => {
    const dryRun = process.env.COFORGE_ORPHAN_COMPUTER_SWEEP === "dry-run";
    void Promise.resolve()
      .then(() => requireDatabaseClient())
      .then((db) => sweepOrphanComputerLinks(db, new Date(), { dryRun }))
      .then((result) =>
        console.info(
          JSON.stringify({
            event: "computer_orphan_sweep_tick",
            dry_run: dryRun,
            ...result,
          }),
        ),
      )
      .catch((error: unknown) =>
        console.warn(
          JSON.stringify({
            event: "computer_orphan_sweep_tick_failed",
            error_type: error instanceof Error ? error.name : "unknown",
          }),
        ),
      );
  };
  // A first tick at boot: a daily-spaced interval alone would wait an hour after every deploy.
  tick();
  const handle = setInterval(tick, SWEEP_INTERVAL_MS);
  handle.unref();
  sweep = {
    stop: () => {
      clearInterval(handle);
      sweep = undefined;
    },
  };
  onServerShutdown(() => sweep?.stop());
}
