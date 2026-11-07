import type { PrismaClient } from "#src/generated/prisma/client";
import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";
import { PrismaUsageLimitEventRepository } from "#src/server/db/repositories/usage-limit-events.repositories.server";
import type { UsageLimitChangedEvent } from "#src/features/usage-limits/usage-limit-events";
import { computerLabel } from "#src/features/computers/computer-identity";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { canSeeUsageLimits } from "#src/server/workspaces/member-role.server";
import { AppError } from "#src/lib/app-error";

/** `runtimeError.errorReason` values that mean a provider's usage limit ran out. */
const USAGE_LIMIT_ERROR_REASONS = new Set(["quota_exhausted", "billing_exhausted"]);

export type UsageLimitObservation = { provider: string; resetsAt: Date | null };

/**
 * What one first-seen Activity means for usage-limit events (task #611): a
 * quota/billing runtime error that names its runtime provider opens or merges
 * an event. Every other frame — including frames from daemons too old to send
 * `runtimeProvider`, other runtime errors, stops and ordinary work — changes
 * nothing here: recovery and gone-Agent detection belong to the sweep, whose
 * cost follows open events rather than the Activity write rate.
 */
export function usageLimitObservation(
  activity: TrustedAgentActivity,
): UsageLimitObservation | null {
  const reason = activity.runtimeError?.errorReason;
  if (!reason || !USAGE_LIMIT_ERROR_REASONS.has(reason)) return null;
  if (!activity.runtimeProvider) return null;
  // Only a quota report names a reset; a billing balance has none to wait for.
  const retry = reason === "quota_exhausted" ? activity.runtimeError?.retryNotBefore : undefined;
  const resetsAt = retry ? new Date(retry) : null;
  return {
    provider: activity.runtimeProvider,
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
  };
}

/** Announces one transition to every owner/admin of the event's Workspace. */
export type UsageLimitAnnouncer = (changes: readonly UsageLimitChangedEvent[]) => Promise<void>;

/**
 * The Activity-write hook's usage-limit half. Runs only for first-seen rows
 * (the caller checks the insert), so a replayed frame never reopens an event
 * a recovery or the sweep already closed. Announces when the report opened
 * the event or put a new Agent into its affected set — never for a repeat
 * report of an Agent already counted.
 */
export async function observeUsageLimitActivity(
  db: PrismaClient,
  activity: TrustedAgentActivity,
  announce?: UsageLimitAnnouncer,
): Promise<void> {
  const observation = usageLimitObservation(activity);
  if (!observation) return;
  const repo = new PrismaUsageLimitEventRepository(db);
  const result = await repo.openOrMerge({
    workspaceId: activity.workspaceId,
    computerId: activity.computerId,
    agentId: activity.agentId,
    provider: observation.provider,
    resetsAt: observation.resetsAt,
  });
  if (!announce || (!result.opened && !result.agentAdded)) return;
  await announce([
    {
      type: REALTIME_EVENTS.usageLimitChanged,
      workspaceId: activity.workspaceId,
      eventId: result.id,
      status: "open",
      affectedCount: result.affectedCount,
      resetsAt: result.resetsAt?.toISOString() ?? null,
    },
  ]);
}

/**
 * The owner/admin-only reads and marks behind the reminder UI (task #611).
 * Every verb fails closed on any other role.
 */
export class UsageLimitEvents {
  private readonly repo: PrismaUsageLimitEventRepository;

  constructor(db: PrismaClient) {
    this.repo = new PrismaUsageLimitEventRepository(db);
  }

  /** The Workspace's open events with the viewer's own seen/dismiss marks. */
  async listForViewer(workspaceId: string, userId: string, role: string | undefined) {
    this.assertElevated(role);
    const events = await this.repo.listOpenForViewer(workspaceId, userId);
    return events.map(({ computer, ...event }) => ({
      ...event,
      computerName: computerLabel(computer),
    }));
  }

  /** Marks the event seen for this owner/admin; false when it is not the Workspace's. */
  async markSeen(
    workspaceId: string,
    userId: string,
    role: string | undefined,
    eventId: string,
  ): Promise<boolean> {
    this.assertElevated(role);
    return this.repo.markSeen(eventId, userId, workspaceId);
  }

  /** Dismisses the event for this owner/admin until it closes. */
  async dismiss(
    workspaceId: string,
    userId: string,
    role: string | undefined,
    eventId: string,
  ): Promise<boolean> {
    this.assertElevated(role);
    return this.repo.dismiss(eventId, userId, workspaceId);
  }

  private assertElevated(role: string | undefined): void {
    if (!canSeeUsageLimits(role)) throw new AppError("ACCESS_DENIED");
  }
}
