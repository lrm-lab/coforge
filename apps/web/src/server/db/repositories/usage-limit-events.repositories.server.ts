import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import {
  USAGE_LIMIT_CLOSE_REASONS,
  type UsageLimitCloseReason,
} from "#src/features/usage-limits/usage-limit-events";
import { WORKSPACE_ADMIN_ROLES } from "#src/features/workspaces/workspace-roles";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

export { USAGE_LIMIT_CLOSE_REASONS };
export type { UsageLimitCloseReason };

/**
 * One transition worth announcing: the event's state after it. `affectedCount`
 * is the size of the affected-Agent set (0 once the event closed empty);
 * `resetsAt` is the latest reported reset, null when none was ever named.
 */
export type UsageLimitEventChange = {
  id: string;
  workspaceId: string;
  provider: string;
  status: "open" | "closed";
  closeReason: UsageLimitCloseReason | null;
  affectedCount: number;
  resetsAt: Date | null;
};

/** Bounds one sweep pass's per-statement work regardless of backlog size. */
const SWEEP_BATCH_LIMIT = 200;

/**
 * The detail kinds that evidence a recovery (task #611): rows only a provider
 * that produced work can send — a response or thinking run with content, a
 * tool or command running or finishing, a compaction or review pass starting,
 * subagent progress. Everything else fails safe: `model_request_started` is
 * emitted before the request's outcome is known, so a failed retry would
 * count as recovery; run-start markers never persist without entries, but
 * `thinking_end` is synthesized on the error event that ends a thinking run,
 * `compaction_finished`/`review_finished` can be daemon inferences, and
 * lifecycle, launch-warning, `idle` and `other` rows say nothing about the
 * provider working again.
 */
const RECOVERY_DETAIL_KINDS = new Set<string>([
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT,
  AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES,
]);

/**
 * The `usage_limit_events` store (task #611). Every close is a conditional
 * `updateMany` on `status = 'open'`, so of two racing closers only the winner
 * reports the event and only it announces the change.
 */
export class PrismaUsageLimitEventRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Opens the scope's event, or merges this report into the open one: the
   * affected Agent joins the set and `resetsAt` keeps the maximum reported
   * reset (a report naming none never clears a known one). `opened` is true
   * only for the call that created the event and `agentAdded` only when this
   * report put a new Agent into the set, so a replayed or already-counted
   * report announces nothing.
   */
  async openOrMerge(input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    provider: string;
    resetsAt: Date | null;
  }): Promise<{
    id: string;
    opened: boolean;
    agentAdded: boolean;
    affectedCount: number;
    resetsAt: Date | null;
  }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.db.$transaction(async (tx) => {
          const event = await tx.usageLimitEvent.create({
            data: {
              workspaceId: input.workspaceId,
              computerId: input.computerId,
              provider: input.provider,
              resetsAt: input.resetsAt,
            },
            select: { id: true },
          });
          await tx.usageLimitEventAgent.create({
            data: {
              eventId: event.id,
              agentId: input.agentId,
              workspaceId: input.workspaceId,
            },
          });
          return {
            id: event.id,
            opened: true,
            agentAdded: true,
            affectedCount: 1,
            resetsAt: input.resetsAt,
          };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const merged = await this.mergeIntoOpen(input);
        if (merged) return merged;
        // The winning event closed between the failed create and this read;
        // loop once more to open a fresh one.
      }
    }
    throw new Error("usage limit event scope kept racing");
  }

  /** Merges into the scope's open event; undefined when none is open anymore. */
  private async mergeIntoOpen(input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    provider: string;
    resetsAt: Date | null;
  }): Promise<
    | {
        id: string;
        opened: boolean;
        agentAdded: boolean;
        affectedCount: number;
        resetsAt: Date | null;
      }
    | undefined
  > {
    return this.db.$transaction(async (tx) => {
      const event = await tx.usageLimitEvent.findFirst({
        where: {
          workspaceId: input.workspaceId,
          computerId: input.computerId,
          provider: input.provider,
          status: "open",
        },
        select: { id: true, resetsAt: true },
      });
      if (!event) return undefined;
      // Lock the event row and re-verify it is still open: a sweep closing it
      // (empty affected set, reset passed, aged out) must not race this merge
      // into leaving a member on a closed event. Lock order is always the
      // event row first, then its member rows — the sweep's removals take the
      // same order, so the two can never deadlock.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "usage_limit_events"
        WHERE "id" = ${event.id}::uuid AND "status" = 'open'
        FOR UPDATE
      `;
      if (locked.length === 0) return undefined;
      let resetsAt = event.resetsAt;
      if (input.resetsAt) {
        // GREATEST ignores NULLs, so a report without a reset never clears one.
        await tx.$executeRaw`
          UPDATE "usage_limit_events"
          SET "resetsAt" = GREATEST("resetsAt", ${input.resetsAt})
          WHERE "id" = ${event.id}::uuid
        `;
        if (!resetsAt || input.resetsAt.getTime() > resetsAt.getTime()) resetsAt = input.resetsAt;
      }
      const member = await tx.usageLimitEventAgent.findUnique({
        where: { eventId_agentId: { eventId: event.id, agentId: input.agentId } },
        select: { agentId: true },
      });
      // Upsert, not create: two reports for the same new Agent may race, and
      // the loser must still count the merge rather than fail the frame.
      await tx.usageLimitEventAgent.upsert({
        where: { eventId_agentId: { eventId: event.id, agentId: input.agentId } },
        create: {
          eventId: event.id,
          agentId: input.agentId,
          workspaceId: input.workspaceId,
        },
        update: {},
      });
      const affectedCount = await tx.usageLimitEventAgent.count({
        where: { eventId: event.id },
      });
      return {
        id: event.id,
        opened: false,
        agentAdded: !member,
        affectedCount,
        resetsAt,
      };
    });
  }

  /** Closes open events whose reported reset time has passed. */
  async closeResetPassed(now: Date): Promise<UsageLimitEventChange[]> {
    return this.closeWhere({ status: "open", resetsAt: { not: null, lte: now } }, "reset_passed");
  }

  /** Closes open events older than the defensive bound. */
  async closeAgedOut(openedBefore: Date): Promise<UsageLimitEventChange[]> {
    return this.closeWhere({ status: "open", openedAt: { lte: openedBefore } }, "aged_out");
  }

  /**
   * Drops affected-set rows whose Agent was deleted or explicitly stopped,
   * then closes each open event the removal empties as `agents_gone`. An
   * event that keeps members reports the shrink as an open change.
   */
  async removeGoneAgents(): Promise<UsageLimitEventChange[]> {
    const gone = await this.db.usageLimitEventAgent.findMany({
      where: {
        event: { status: "open" },
        agent: { OR: [{ deletedAt: { not: null } }, { stoppedAt: { not: null } }] },
      },
      select: { eventId: true, agentId: true },
      take: SWEEP_BATCH_LIMIT,
    });
    const byEvent = new Map<string, string[]>();
    for (const row of gone) {
      const agents = byEvent.get(row.eventId) ?? [];
      agents.push(row.agentId);
      byEvent.set(row.eventId, agents);
    }
    return this.removeAgentsFromOpenEvents(
      [...byEvent].map(([eventId, agentIds]) => ({ eventId, agentIds })),
      "agents_gone",
    );
  }

  /**
   * The recovery half of the sweep (task #611): an affected Agent that shows
   * provider-work Activity (`RECOVERY_DETAIL_KINDS`) — or sent a Message —
   * after the event opened has recovered, so it leaves the set; an event the
   * removal empties closes as `recovered`. Cost follows open events, never
   * the Activity write rate.
   */
  async removeRecoveredAgents(): Promise<UsageLimitEventChange[]> {
    const events = await this.db.usageLimitEvent.findMany({
      where: { status: "open" },
      select: {
        id: true,
        workspaceId: true,
        openedAt: true,
        agents: {
          select: {
            agentId: true,
            agent: { select: { stoppedAt: true, deletedAt: true } },
          },
        },
      },
      take: SWEEP_BATCH_LIMIT,
    });
    const removals: { eventId: string; agentIds: string[] }[] = [];
    for (const event of events) {
      const liveIds = event.agents
        .filter(({ agent }) => !agent.stoppedAt && !agent.deletedAt)
        .map(({ agentId }) => agentId);
      if (liveIds.length === 0) continue;
      const recovered = await this.recoveredAgentIds(liveIds, event.workspaceId, event.openedAt);
      if (recovered.length > 0) removals.push({ eventId: event.id, agentIds: recovered });
    }
    return this.removeAgentsFromOpenEvents(removals, "recovered");
  }

  /** The subset of `agentIds` with post-`openedAt` recovery evidence. */
  private async recoveredAgentIds(
    agentIds: string[],
    workspaceId: string,
    openedAt: Date,
  ): Promise<string[]> {
    const [activities, messages] = await Promise.all([
      this.db.agentActivity.findMany({
        where: {
          workspaceId,
          agentId: { in: agentIds },
          createdAt: { gt: openedAt },
          detailKind: { in: [...RECOVERY_DETAIL_KINDS] },
        },
        select: { agentId: true },
        distinct: ["agentId"],
      }),
      this.db.conversationMember.findMany({
        where: {
          workspaceId,
          agentId: { in: agentIds },
          messages: { some: { createdAt: { gt: openedAt } } },
        },
        select: { agentId: true },
        distinct: ["agentId"],
      }),
    ]);
    const recovered = new Set(activities.map((row) => row.agentId));
    for (const row of messages) if (row.agentId) recovered.add(row.agentId);
    return [...recovered];
  }

  /**
   * Removes `agentIds` from each named open event and closes the ones the
   * removal empties with `closeReason`; every event that actually changed —
   * shrunk or closed — reports its new state for announcement.
   */
  private async removeAgentsFromOpenEvents(
    removals: readonly { eventId: string; agentIds: string[] }[],
    closeReason: Extract<UsageLimitCloseReason, "recovered" | "agents_gone">,
  ): Promise<UsageLimitEventChange[]> {
    const changes: UsageLimitEventChange[] = [];
    for (const { eventId, agentIds } of removals) {
      const removed = await this.db.$transaction(async (tx) => {
        // Lock the event row first (the merge path takes the same lock, so a
        // report and a removal can never interleave into a member on a closed
        // event or an open event with an empty set). A second remover waits
        // here, then counts the first's committed deletes.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "usage_limit_events"
          WHERE "id" = ${eventId}::uuid AND "status" = 'open'
          FOR UPDATE
        `;
        if (locked.length === 0) return 0;
        const deleted = await tx.usageLimitEventAgent.deleteMany({
          where: { eventId, agentId: { in: agentIds } },
        });
        if (deleted.count === 0) return 0;
        const remaining = await tx.usageLimitEventAgent.count({ where: { eventId } });
        if (remaining === 0) {
          await tx.usageLimitEvent.updateMany({
            where: { id: eventId, status: "open" },
            data: { status: "closed", closedAt: new Date(), closeReason },
          });
        }
        return deleted.count;
      });
      if (removed > 0) changes.push(await this.describe(eventId));
    }
    return changes;
  }

  /** Every open event of the Workspace with the viewer's own seen/dismiss marks. */
  async listOpenForViewer(workspaceId: string, userId: string) {
    const events = await this.db.usageLimitEvent.findMany({
      where: { workspaceId, status: "open" },
      orderBy: { openedAt: "desc" },
      include: {
        agents: {
          select: {
            agent: { select: { id: true, name: true, displayName: true } },
          },
        },
        views: { where: { userId }, select: { seenAt: true, dismissedAt: true } },
      },
    });
    return events.map(({ agents, views, ...event }) => ({
      ...event,
      agents: agents.map(({ agent }) => agent),
      viewer: views[0] ?? { seenAt: null, dismissedAt: null },
    }));
  }

  /** First write wins: a seen or dismissed mark keeps its earliest time. False when the
   * event is not this Workspace's. */
  async markSeen(eventId: string, userId: string, workspaceId: string): Promise<boolean> {
    return this.mark(eventId, userId, workspaceId, "seenAt");
  }

  async dismiss(eventId: string, userId: string, workspaceId: string): Promise<boolean> {
    return this.mark(eventId, userId, workspaceId, "dismissedAt");
  }

  private async mark(
    eventId: string,
    userId: string,
    workspaceId: string,
    field: "seenAt" | "dismissedAt",
  ): Promise<boolean> {
    const event = await this.db.usageLimitEvent.findFirst({
      where: { id: eventId, workspaceId },
      select: { id: true },
    });
    if (!event) return false;
    const now = new Date();
    const isSeen = field === "seenAt";
    const where = isSeen
      ? { eventId, userId, seenAt: null }
      : { eventId, userId, dismissedAt: null };
    const data = isSeen ? { seenAt: now } : { dismissedAt: now };
    const filled = await this.db.usageLimitEventView.updateMany({ where, data });
    if (filled.count > 0) return true;
    try {
      await this.db.usageLimitEventView.create({
        data: isSeen ? { eventId, userId, seenAt: now } : { eventId, userId, dismissedAt: now },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent mark (of either field — one row holds both) created the
      // view first; fill this field if it is still null.
      await this.db.usageLimitEventView.updateMany({ where, data });
    }
    return true;
  }

  /** The Workspace's owner/admin members — the only audience a change may reach. */
  async elevatedUserIds(workspaceId: string): Promise<string[]> {
    const memberships = await this.db.workspaceMembership.findMany({
      where: { workspaceId, role: { in: [...WORKSPACE_ADMIN_ROLES] } },
      select: { userId: true },
    });
    return memberships.map((membership) => membership.userId);
  }

  /** One conditional close per candidate event; returns each event's new state. */
  private async closeWhere(
    where: Prisma.UsageLimitEventWhereInput,
    closeReason: UsageLimitCloseReason,
  ): Promise<UsageLimitEventChange[]> {
    const candidates = await this.db.usageLimitEvent.findMany({
      where,
      select: { id: true },
      take: SWEEP_BATCH_LIMIT,
    });
    const changes: UsageLimitEventChange[] = [];
    for (const { id } of candidates) {
      const updated = await this.db.usageLimitEvent.updateMany({
        where: { id, status: "open" },
        data: { status: "closed", closedAt: new Date(), closeReason },
      });
      if (updated.count > 0) changes.push(await this.describe(id));
    }
    return changes;
  }

  /** The event's announce shape as it stands now. */
  private async describe(id: string): Promise<UsageLimitEventChange> {
    const event = await this.db.usageLimitEvent.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        status: true,
        closeReason: true,
        resetsAt: true,
        _count: { select: { agents: true } },
      },
    });
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      provider: event.provider,
      status: event.status === "open" ? "open" : "closed",
      closeReason: (event.closeReason as UsageLimitCloseReason | null) ?? null,
      affectedCount: event._count.agents,
      resetsAt: event.resetsAt,
    };
  }
}
