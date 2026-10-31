import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { parseActivityEntries, type AgentActivity } from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { activityKindForObservation } from "#src/server/agents/agent-activity-kind";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { managedAgentWhere } from "#src/server/agents/agent-visibility.server";
import { AGENT_ACTIVITY_WINDOW } from "#src/features/agents/agent-activity-window";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";

export type TrustedAgentActivity = AgentActivity & { computerId: string };

type CompactActivity = {
  agentId: string;
  id: string;
  launchId: string;
  clientSeq: number;
  conversationId: string | null;
  conversationTarget: string | null;
  detailKind: string;
  level: string;
  detail: string;
  entries: unknown;
  occurredAt: Date;
  createdAt: Date;
  slot: bigint;
};

type CompactActivityRow =
  | CompactActivity
  | (Record<Exclude<keyof CompactActivity, "agentId">, null> & {
      agentId: string;
    });

function activityKind(activity: { detailKind: string; level: string }) {
  if (activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.STOPPED) return "offline" as const;
  if (!(["info", "warning", "error"] as const).some((level) => level === activity.level))
    return undefined;
  return activityKindForObservation({
    detailKind: activity.detailKind,
    level: activity.level === "error" ? "error" : activity.level === "warning" ? "warning" : "info",
  });
}

/**
 * The conversations whose Activity the viewer may not see (task #302: a manager outside a private
 * channel sees none of what the Agent did there): the channels `visibleChannelWhere` keeps from
 * them, and those channels' Tasks' own conversations. Read once per request, so each Activity row
 * is checked against a list instead of probing its channel: the Agent card's five-row index walk
 * stays one, where a probe per row made the planner read an Agent's whole history.
 */
async function unreadableConversationIds(db: PrismaClient, workspaceId: string, userId: string) {
  const channels = await db.conversation.findMany({
    where: {
      workspaceId,
      channelName: { not: null },
      NOT: visibleChannelWhere(workspaceId, { userId }),
    },
    select: { id: true },
  });
  if (channels.length === 0) return [];
  const channelIds = channels.map((channel) => channel.id);
  const discussions = await db.task.findMany({
    where: { conversationId: { in: channelIds }, discussionConversationId: { not: null } },
    select: { discussionConversationId: true },
  });
  return [
    ...channelIds,
    ...discussions.flatMap((task) =>
      task.discussionConversationId ? [task.discussionConversationId] : [],
    ),
  ];
}

/** `unreadableConversationIds` as a filter over `"agent_activities" activity`; a row naming no
 * conversation, a DM or a conversation since deleted is kept. */
function readableActivitySql(unreadable: readonly string[]) {
  return unreadable.length
    ? Prisma.sql`AND (activity."conversationId" IS NULL
        OR NOT (activity."conversationId" = ANY(${unreadable}::uuid[])))`
    : Prisma.empty;
}

export class AgentActivityRepository {
  constructor(private readonly db: PrismaClient) {}

  /** The recent Activity of the Agents `userId` manages (`managedAgentWhere`: their own, or any
   * for a Workspace owner/admin), for the Agent card. */
  async listForManager(workspaceId: string, userId: string) {
    // The Agents the viewer manages, resolved once and reused as a plain id filter inside the
    // CTE below (SQL never re-derives the rule itself, so the two can never disagree).
    const managedAgents = await this.db.agent.findMany({
      where: { ...managedAgentWhere({ userId, workspaceId }), ...ACTIVE_AGENT_WHERE },
      select: { id: true },
    });
    const managedAgentIds = managedAgents.map((agent) => agent.id);
    if (managedAgentIds.length === 0) return [];
    // In both reads of a launch's rows, so a slot's position counts only rows the viewer reads.
    const readable = readableActivitySql(
      await unreadableConversationIds(this.db, workspaceId, userId),
    );
    const rows = await this.db.$queryRaw<CompactActivityRow[]>`
      WITH authorized_agents AS (
        SELECT agent."id"
        FROM "agents" AS agent
        INNER JOIN "workspace_memberships" AS membership
          ON membership."workspaceId" = agent."workspaceId"
        WHERE agent."workspaceId" = ${workspaceId}::uuid
          AND agent."deletedAt" IS NULL
          AND membership."userId" = ${userId}::uuid
          AND agent."id" = ANY(${managedAgentIds}::uuid[])
      ),
      -- Each Agent's five newest rows, read from the head of its
      -- (workspaceId, agentId, occurredAt DESC) index instead of ranking its whole history.
      recent AS (
        SELECT
          agent."id" AS "agentId",
          recent."launchId",
          ROW_NUMBER() OVER (
            PARTITION BY agent."id"
            ORDER BY recent."occurredAt" DESC, recent."createdAt" DESC, recent."id" DESC
          ) AS slot
        FROM authorized_agents AS agent
        CROSS JOIN LATERAL (
          SELECT activity."id", activity."launchId", activity."occurredAt", activity."createdAt"
          FROM "agent_activities" AS activity
          WHERE activity."workspaceId" = ${workspaceId}::uuid
            AND activity."agentId" = agent."id"
            ${readable}
          ORDER BY activity."occurredAt" DESC, activity."createdAt" DESC, activity."id" DESC
          LIMIT 5
        ) AS recent
      ),
      -- A clock rollback can reorder a launch's rows by time, so the slot's k-th newest row of
      -- its launch shows that launch's k-th highest clientSeq instead. Every newer row of the
      -- launch is also newer overall, so k is its rank among these five slots.
      positioned AS (
        SELECT
          recent.*,
          ROW_NUMBER() OVER (
            PARTITION BY recent."agentId", recent."launchId"
            ORDER BY recent.slot
          ) AS launch_position
        FROM recent
      ),
      compact AS (
        SELECT sequenced.*, positioned.slot
        FROM positioned
        CROSS JOIN LATERAL (
          SELECT
            activity."id",
            activity."agentId",
            activity."launchId",
            activity."clientSeq",
            activity."conversationId",
            activity."conversationTarget",
            activity."detailKind",
            activity."level",
            activity."detail",
            activity."entries",
            activity."occurredAt",
            activity."createdAt"
          FROM "agent_activities" AS activity
          WHERE activity."workspaceId" = ${workspaceId}::uuid
            AND activity."agentId" = positioned."agentId"
            AND activity."launchId" = positioned."launchId"
            ${readable}
          ORDER BY activity."clientSeq" DESC
          OFFSET positioned.launch_position - 1
          LIMIT 1
        ) AS sequenced
      )
      SELECT
        agent."id" AS "agentId",
        compact."id",
        compact."launchId",
        compact."clientSeq",
        compact."conversationId",
        compact."conversationTarget",
        compact."detailKind",
        compact."level",
        compact."detail",
        compact."entries",
        compact."occurredAt",
        compact."createdAt",
        compact.slot
      FROM authorized_agents AS agent
      LEFT JOIN compact ON compact."agentId" = agent."id"
      ORDER BY agent."id", compact.slot ASC NULLS LAST
    `;
    const agents = new Map<string, { id: string; activity: CompactActivity[] }>();
    for (const row of rows) {
      const agent = agents.get(row.agentId) ?? {
        id: row.agentId,
        activity: [],
      };
      agents.set(row.agentId, agent);
      if (row.id === null) continue;
      agent.activity.push(row);
    }
    return [...agents.values()].map(({ id, activity }) => ({
      id,
      activity: activity.map(
        ({
          id: activityId,
          launchId,
          clientSeq,
          conversationId,
          conversationTarget,
          detailKind,
          level,
          detail,
          entries,
          occurredAt,
          createdAt,
        }) => ({
          id: activityId,
          launchId,
          clientSeq,
          ...(conversationId ? { conversationId, conversationTarget } : {}),
          detailKind,
          level,
          detail,
          activityKind: activityKind({ detailKind, level }),
          entries: entries === null ? [] : parseActivityEntries(entries),
          observedAtMs: occurredAt.getTime(),
          createdAt,
        }),
      ),
    }));
  }

  async record(input: TrustedAgentActivity) {
    await this.recordMany([input]);
  }

  /** One insert for many rows; a row already stored (same Agent, launch, and sequence) is kept. */
  async recordMany(inputs: readonly TrustedAgentActivity[]) {
    await this.db.agentActivity.createMany({
      data: inputs.map((input) => ({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        computerId: input.computerId,
        launchId: input.launchId,
        clientSeq: input.clientSeq,
        conversationId: input.conversationId,
        conversationTarget: input.conversationTarget,
        detailKind: input.detailKind,
        level: input.level,
        detail: input.detail,
        entries: input.entries,
        runtimeErrorClass: input.runtimeError?.errorClass,
        runtimeErrorReason: input.runtimeError?.errorReason,
        runtimeErrorFingerprint: input.runtimeError?.fingerprint,
        occurredAt: new Date(input.observedAtMs),
      })),
      skipDuplicates: true,
    });
  }

  /** One Agent's Activity feed, when `userId` manages it (`managedAgentWhere`); else undefined. */
  async feedForManager(workspaceId: string, userId: string, agentId: string) {
    const managed = await this.db.agent.findFirst({
      where: { id: agentId, ...managedAgentWhere({ userId, workspaceId }), ...ACTIVE_AGENT_WHERE },
      select: { id: true },
    });
    return managed ? this.list(workspaceId, agentId, userId) : undefined;
  }

  /** The Agent's newest Activity the viewer `userId` may read (`unreadableConversationIds`). */
  async list(workspaceId: string, agentId: string, userId: string) {
    const unreadable = await unreadableConversationIds(this.db, workspaceId, userId);
    const rows = await this.db.agentActivity.findMany({
      where: {
        workspaceId,
        agentId,
        ...(unreadable.length
          ? { OR: [{ conversationId: null }, { conversationId: { notIn: unreadable } }] }
          : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { clientSeq: "desc" }, { createdAt: "desc" }],
      take: AGENT_ACTIVITY_WINDOW,
    });
    return rows.map(
      ({
        occurredAt,
        entries,
        runtimeErrorClass,
        runtimeErrorReason,
        runtimeErrorFingerprint,
        ...row
      }) => ({
        ...row,
        activityKind: activityKind(row),
        observedAtMs: occurredAt.getTime(),
        entries: entries === null ? [] : parseActivityEntries(entries),
        ...(runtimeErrorClass
          ? {
              runtimeError: {
                errorClass: runtimeErrorClass,
                errorReason: runtimeErrorReason ?? "",
                fingerprint: runtimeErrorFingerprint ?? "",
              },
            }
          : {}),
      }),
    );
  }
}
