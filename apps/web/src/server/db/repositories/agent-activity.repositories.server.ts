import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { parseActivityEntries, type AgentActivity } from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { activityKindForObservation } from "#src/server/agents/agent-activity-kind";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { managedAgentWhere } from "#src/server/agents/agent-visibility.server";
import { AGENT_ACTIVITY_WINDOW } from "#src/features/agents/agent-activity-window";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";

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
 * An Activity row the viewer may read, over `"agent_activities"` under `alias` (a
 * repository-owned identifier): one in a channel, or in the Task conversation of a channel's
 * Task, only when `readableChannelSql` lets the viewer read that channel (task #302: a manager
 * outside a private channel sees none of what the Agent did there). A row naming no
 * conversation, a DM or a conversation since deleted is kept.
 */
function readableActivitySql(alias: string, workspaceId: string, userId: string) {
  const activity = Prisma.raw(alias);
  const reader = { userId };
  return Prisma.sql`(${activity}."conversationId" IS NULL OR NOT EXISTS (
    SELECT 1
    FROM "conversations" AS place
    LEFT JOIN "tasks" AS task ON task."discussionConversationId" = place."id"
    LEFT JOIN "conversations" AS board ON board."id" = task."conversationId"
    WHERE place."id" = ${activity}."conversationId"
      AND (
        (place."channelName" IS NOT NULL AND NOT ${readableChannelSql("place", workspaceId, reader)})
        OR (board."channelName" IS NOT NULL AND NOT ${readableChannelSql("board", workspaceId, reader)})
      )))`;
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
    const readable = readableActivitySql("activity", workspaceId, userId);
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
            AND ${readable}
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
            AND ${readable}
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

  /** The Agent's newest Activity the viewer `userId` may read (`readableActivitySql`). */
  async list(workspaceId: string, agentId: string, userId: string) {
    const readable = await this.db.$queryRaw<{ id: string }[]>`
      SELECT activity."id"
      FROM "agent_activities" AS activity
      WHERE activity."workspaceId" = ${workspaceId}::uuid
        AND activity."agentId" = ${agentId}::uuid
        AND ${readableActivitySql("activity", workspaceId, userId)}
      ORDER BY activity."occurredAt" DESC, activity."clientSeq" DESC, activity."createdAt" DESC
      LIMIT ${AGENT_ACTIVITY_WINDOW}
    `;
    const rows = await this.db.agentActivity.findMany({
      where: { id: { in: readable.map((row) => row.id) } },
      orderBy: [{ occurredAt: "desc" }, { clientSeq: "desc" }, { createdAt: "desc" }],
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
