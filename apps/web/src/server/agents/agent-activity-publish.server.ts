import { isRecord } from "@lrm/coforge-sdk/internal";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { encodeAgentActivity } from "@lrm/coforge-sdk/internal";
import { decodeAgentActivityFrame } from "@lrm/coforge-sdk/internal/reply-intent";

import { getDatabaseClient } from "#src/server/db/client.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  AgentActivityRepository,
  type TrustedAgentActivity,
} from "#src/server/db/repositories/agent-activity.repositories.server";
import { activityKindForObservation } from "./agent-activity-kind";
import { getAgentDisplay, type AgentDisplay } from "./agent-display.server";
import { ensureAgentActivitySweep } from "./agent-activity-sweep.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { agentStatusChannelFor } from "#src/features/agents/agent-status-channel";
import { agentActivityChannel, isRunStartMarker } from "#src/features/agents/agent-activity";
import { normalizeAgentVisibility } from "#src/features/agents/agent-visibility";
import {
  agentInPublicationScope,
  publicationDenied as unauthorized,
  relayActivityFrame,
  relayActivityToPeople,
} from "./agent-activity-relay.server";
import {
  cachedActivityAudience,
  prismaActivityAudienceReads,
  type AudienceAgent,
} from "./agent-activity-audience.server";
import { forgetChannelPeopleWith } from "#src/server/conversations/channel-people-invalidation.server";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import {
  handleReplyIntentPublication,
  type ReplyIntentPublicationDependencies,
} from "./reply-intent-publish.server";
import { cachedReplyTargetResolver } from "./reply-target-cache.server";
import { cachedWorkspaceComputerCheck } from "./workspace-computer-cache.server";
import { getWorkspaceComputerInvalidation } from "./workspace-computer-invalidation.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { AgentActivityKind } from "@lrm/coforge-sdk/internal";

type AgentActivityPublicationDependencies = ReplyIntentPublicationDependencies & {
  proxySecret: string | undefined;
  observe(activity: TrustedAgentActivity): Promise<void>;
  currentRuntimeFence?(
    workspaceId: string,
    computerId: string,
    agentId: string,
  ): Promise<{ daemonInstanceId: string; launchId: string } | undefined>;
  display?: Pick<AgentDisplay, "observeActivity">;
  publishJson?(channel: string, data: unknown): Promise<void>;
};

/** Validate one client-originated Centrifugo publication before it reaches the Activity channel. */
export async function handleAgentActivityPublication(
  request: Request,
  dependencies: AgentActivityPublicationDependencies,
): Promise<Response> {
  if (
    !dependencies.proxySecret ||
    request.headers.get("x-coforge-centrifugo-proxy-secret") !== dependencies.proxySecret
  )
    return unauthorized();

  try {
    const body = (await request.json()) as {
      user?: unknown;
      channel?: unknown;
      b64data?: unknown;
      meta?: { workspace_id?: unknown; computer_id?: unknown };
    };
    const workspaceId = body.meta?.workspace_id;
    const computerId = body.meta?.computer_id;
    if (
      typeof body.user !== "string" ||
      typeof workspaceId !== "string" ||
      typeof computerId !== "string" ||
      typeof body.b64data !== "string" ||
      body.channel !== agentActivityChannel(workspaceId)
    )
      return unauthorized();

    const payload = Uint8Array.from(atob(body.b64data), (character) => character.charCodeAt(0));
    const decoded = decodeAgentActivityFrame(payload);
    // An "about to post" signal rides this channel but is no observation (no launch, never stored).
    if ("replyIntent" in decoded)
      return await handleReplyIntentPublication(
        decoded.replyIntent,
        { workspaceId, computerId },
        dependencies,
      );
    const { activity } = decoded;
    if (
      activity.protocolMajor !== 1 ||
      activity.workspaceId !== workspaceId ||
      !(await agentInPublicationScope(dependencies, {
        workspaceId,
        computerId,
        agentId: activity.agentId,
      }))
    )
      return unauthorized();

    const mappedKind: AgentActivityKind | undefined =
      activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.STOPPED
        ? "offline"
        : activityKindForObservation(activity);
    const cloudActivity = { ...activity, activityKind: mappedKind };
    // A busy heartbeat, a content-free runtime_progress frame, a content-free run-start
    // marker (thinking_started/model_response_started with no entries — see
    // isRunStartMarker), or a reply to the server's own liveness probe only renews the
    // display lease; none of them carry anything worth keeping in history.
    // tool_end, thinking_end and compaction_finished are ordinary status
    // observations now and are persisted like any other Activity — the log records tool
    // and thinking completion, only content-free progress pings stay lease-only.
    const isFillerActivity =
      activity.isHeartbeat === true ||
      activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS ||
      isRunStartMarker(activity.detailKind, activity.entries) ||
      Boolean(activity.probeId);
    // Read fresh, no cache. `agentBelongsToWorkspace` above already rejected an Agent
    // that is not in the workspace; "lookup found nothing to route by" here is the only other
    // way to reach `undefined`, and it is rejected the same way — never assumed public. A
    // recognized non-"public" value routes to the per-Agent channels; an unrecognized persisted
    // value fails closed to private the same way `canSeeAgent`/`visibleAgentWhere` do.
    const visibility = await dependencies.agentVisibility(workspaceId, activity.agentId);
    if (visibility === undefined) return unauthorized();
    const statusChannel = agentStatusChannelFor(workspaceId, activity.agentId, visibility);
    // Work in a private channel is its people's alone (task #302): the frame goes to their own
    // channels, and the status everyone who sees the Agent shows keeps its kind, not its words.
    const audience = activity.conversationId
      ? await dependencies.privateAudience?.({
          workspaceId,
          agentId: activity.agentId,
          conversationId: activity.conversationId,
        })
      : undefined;
    const history = isFillerActivity
      ? Promise.resolve()
      : dependencies.observe({ ...cloudActivity, computerId }).catch(() => {});
    const reduce = (async () => {
      if (!dependencies.currentRuntimeFence || !dependencies.display) return;
      const fence = await dependencies.currentRuntimeFence(
        workspaceId,
        computerId,
        activity.agentId,
      );
      if (!fence) return;
      const snapshot = await dependencies.display.observeActivity(
        { ...(audience ? wordless(cloudActivity) : cloudActivity), computerId },
        fence,
      );
      if (snapshot && dependencies.publishJson)
        await dependencies.publishJson(statusChannel, {
          type: "agent:display",
          ...snapshot,
        });
    })().catch(() => {});
    await Promise.all([history, reduce]);

    if (audience)
      return relayActivityToPeople(encodeAgentActivity(cloudActivity), audience, dependencies);
    return relayActivityFrame(
      encodeAgentActivity(cloudActivity),
      { workspaceId, agentId: activity.agentId, visibility },
      dependencies,
    );
  } catch {
    return unauthorized();
  }
}

/** An Activity as the Agent's status shows it to everyone who sees the Agent: its kind, without
 * the conversation it was in or what it said. */
function wordless<Activity extends AgentActivityWords>({
  conversationId: _conversation,
  conversationTarget: _target,
  entries: _entries,
  ...activity
}: Activity) {
  return { ...activity, detail: "" };
}
type AgentActivityWords = {
  conversationId?: string;
  conversationTarget?: string;
  entries?: unknown;
  detail: string;
};

type PublicationAgentLookups = Pick<
  AgentActivityPublicationDependencies,
  "agentBelongsToWorkspace" | "agentBelongsToComputer" | "agentVisibility" | "currentRuntimeFence"
> & {
  /** What deciding who sees the Agent reads of it (`canSeeAgent`), from the same row. */
  audienceAgent(workspaceId: string, agentId: string): Promise<AudienceAgent | undefined>;
};

/**
 * The Agent-side checks of one publication, all answered by a single narrow read of the Agent
 * row. Every daemon Activity frame, heartbeats and text fragments included, passes these checks,
 * so each must not re-read the row. Build one per publication: the read is shared only within
 * that request, so visibility and the launch fence are still read fresh for every frame. The row
 * is deliberately not filtered by `ACTIVE_AGENT_WHERE`, matching the repository's `getById`.
 */
export function publicationAgentLookups(db: PrismaClient): PublicationAgentLookups {
  const reads = new Map<
    string,
    Promise<{
      workspaceId: string;
      computerId: string | null;
      visibility: string;
      ownerId: string;
      systemKind: string | null;
      runtimeSession: unknown;
    } | null>
  >();
  const read = (agentId: string) => {
    let agent = reads.get(agentId);
    if (!agent) {
      agent = db.agent.findUnique({
        where: { id: agentId },
        select: {
          workspaceId: true,
          computerId: true,
          visibility: true,
          ownerId: true,
          systemKind: true,
          runtimeSession: true,
        },
      });
      reads.set(agentId, agent);
    }
    return agent;
  };
  return {
    agentBelongsToWorkspace: async (workspaceId, agentId) =>
      (await read(agentId))?.workspaceId === workspaceId,
    agentBelongsToComputer: async (workspaceId, agentId, computerId) => {
      const agent = await read(agentId);
      return agent?.workspaceId === workspaceId && agent.computerId === computerId;
    },
    // An unrecognized persisted value fails closed to private (`normalizeAgentVisibility`).
    agentVisibility: async (workspaceId, agentId) => {
      const agent = await read(agentId);
      if (agent?.workspaceId !== workspaceId) return undefined;
      return normalizeAgentVisibility(agent.visibility);
    },
    audienceAgent: async (workspaceId, agentId) => {
      const agent = await read(agentId);
      return agent?.workspaceId === workspaceId ? agent : undefined;
    },
    currentRuntimeFence: async (workspaceId, computerId, agentId) => {
      const agent = await read(agentId);
      if (agent?.workspaceId === workspaceId && agent.computerId === computerId) {
        const session = agent.runtimeSession;
        if (isRecord(session)) {
          const daemonInstanceId = Reflect.get(session, "daemonInstanceId");
          const launchId = Reflect.get(session, "launchId");
          const sessionComputerId = Reflect.get(session, "computerId");
          if (
            sessionComputerId === computerId &&
            typeof daemonInstanceId === "string" &&
            typeof launchId === "string" &&
            daemonInstanceId &&
            launchId
          )
            return { daemonInstanceId, launchId };
        }
      }
      return undefined;
    },
  };
}

/** A reply intent's send targets, read through the send path's own resolution and remembered for a
 * call's repeats. A target the Agent cannot post to rejects: the publication is denied. */
const replyTargets = cachedReplyTargetResolver(async ({ workspaceId, agentId, target }) => {
  const db = getDatabaseClient();
  if (!db) return undefined;
  const { conversationId, threadRootId, peerUserId } = await new PrismaDirectConversationRepository(
    db,
    { oneRequest: true },
  ).resolveAgentReplyTarget(workspaceId, agentId, target);
  return { conversationId, threadRootId, ...(peerUserId ? { peerUserId } : {}) };
});

/** Whether a live Computer is bound to the Workspace. A soft-deleted cloud Computer keeps its
 * link row until the cluster's delete job reports, so the check names `deletedAt` like the
 * workspace roster does. */
export async function workspaceComputerOwned(
  db: PrismaClient,
  workspaceId: string,
  computerId: string,
) {
  return Boolean(
    await db.workspaceComputer.findUnique({
      where: {
        workspaceId_computerId: { workspaceId, computerId },
        computer: { deletedAt: null },
      },
      select: { id: true },
    }),
  );
}

/**
 * Whether the publishing Computer is in the Workspace, remembered briefly
 * (`workspace-computer-cache`): this handler is built once for the process and every daemon
 * Activity frame asks the same pair. The stale window is accepted — `agentBelongsToComputer`
 * still gates each frame's Agent, and the connect proxy re-verifies the pair at connect.
 */
const computerInWorkspace = cachedWorkspaceComputerCheck(async (workspaceId, computerId) => {
  const db = getDatabaseClient();
  if (!db) return false;
  return workspaceComputerOwned(db, workspaceId, computerId);
});

/**
 * Who sees each frame's Activity live (`cachedActivityAudience`), remembered across the process's
 * frames: a public channel's frame costs no query.
 */
const activityAudience = cachedActivityAudience(prismaActivityAudienceReads(getDatabaseClient));

export function createAgentActivityPublicationHandler() {
  // An ownership write drops the cached positive at once, here and on every other instance.
  getWorkspaceComputerInvalidation().forgetWith(computerInWorkspace.forget);
  // So does a change of a channel's visibility or people.
  forgetChannelPeopleWith(activityAudience.forget);
  return async (request: Request) => {
    const db = getDatabaseClient();
    if (!db) return unauthorized();
    const activity = new AgentActivityRepository(db);
    let display: AgentDisplay | undefined;
    let centrifugo: ReturnType<typeof createCentrifugoServerApi> | undefined;
    try {
      display = getAgentDisplay();
      centrifugo = createCentrifugoServerApi();
      // Real traffic: idempotent per process, inert until this composition runs.
      ensureAgentActivitySweep();
    } catch {
      // History acceptance remains independent when the optional display path is unavailable.
    }
    const lookups = publicationAgentLookups(db);
    return handleAgentActivityPublication(request, {
      proxySecret: process.env.COFORGE_CENTRIFUGO_PROXY_SECRET,
      ...lookups,
      computerBelongsToWorkspace: computerInWorkspace.check,
      observe: (observation) => activity.record(observation),
      resolveReplyTarget: replyTargets,
      publish: centrifugo
        ? (channel, data, options) => centrifugo.publish(channel, data, options)
        : undefined,
      display,
      publishJson: centrifugo
        ? (channel, data) => centrifugo.publishJson(channel, data)
        : undefined,
      privateAudience: (scope) =>
        activityAudience.audience(scope, () =>
          lookups.audienceAgent(scope.workspaceId, scope.agentId),
        ),
      publishToPeople: centrifugo
        ? (userIds, frame) =>
            centrifugo.publishBatch(
              userIds.map((userId) => ({
                channel: userConversationChannel(userId),
                data: frame,
                skipHistory: true,
              })),
            )
        : undefined,
    });
  };
}
