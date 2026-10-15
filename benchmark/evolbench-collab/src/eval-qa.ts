import type { MemoryDispositionRecord } from "@lrm/coforge-sdk/agent";
import { RedisClient } from "bun";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { PublicChannels } from "../../../apps/web/src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "../../../apps/web/src/server/conversations/redis-message-request-idempotency.server";
import { unreadAgentMessagesFragment } from "../../../apps/web/src/server/db/repositories/agent-attention.repositories.server";
import type { EvalEnv } from "./env";
import type { EpisodeTerminationReason, ManifestEpisode } from "./types";
import type { EvalWorkspace } from "./workspace";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function episodePrompt(
  episode: ManifestEpisode,
  reminder: string,
  envNote?: string | null,
): string {
  const note = envNote
    ? `\n\n${envNote
        .replaceAll("%TASK_ID%", episode.taskId)
        .replaceAll("%EPISODE_ID%", episode.episodeId)}`
    : "";
  const prompt =
    episode.domain === "information_retrieval"
      ? episode.prompt.split("## How to call search in this environment")[0]!.trimEnd()
      : episode.prompt;
  const body = `${prompt}${note}\n\n${reminder}`.replace(/@memory\b/g, "Memory Agent");
  return `@task @memory ${body}`;
}

export async function postEpisodePrompt(input: {
  workspace: EvalWorkspace;
  redisUrl: string;
  episode: ManifestEpisode;
  reminder: string;
  envNote?: string | null;
}): Promise<{ triggerId: string; createdAt: Date }> {
  const body = episodePrompt(input.episode, input.reminder, input.envNote);
  if (input.redisUrl) {
    const redis = new RedisClient(input.redisUrl);
    try {
      const channels = new PublicChannels(
        input.workspace.db,
        new RedisMessageRequestIdempotency(redis),
      );
      const sent = await channels.send({
        workspaceId: input.workspace.workspaceId,
        userId: input.workspace.evalUserId,
        channelId: input.workspace.channelId,
        idempotencyKey: crypto.randomUUID(),
        body,
      });
      const triggerId = (sent as { id?: string }).id;
      if (!triggerId) throw new Error("channel send did not return a message id");
      return { triggerId, createdAt: sent.createdAt };
    } finally {
      redis.close();
    }
  }
  const member = await input.workspace.db.conversationMember.findFirst({
    where: { conversationId: input.workspace.channelId, userId: input.workspace.evalUserId },
  });
  if (!member) throw new Error("eval user is not a channel member");
  const latest = await input.workspace.db.message.findFirst({
    where: { conversationId: input.workspace.channelId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const created = await input.workspace.db.message.create({
    data: {
      conversationId: input.workspace.channelId,
      workspaceId: input.workspace.workspaceId,
      senderMemberId: member.id,
      body,
      sequence: (latest?.sequence ?? 0) + 1,
    },
  });
  return { triggerId: created.id, createdAt: created.createdAt };
}

export type EpisodeResult = {
  finalOutput: string | null;
  offerMessageId: string | null;
  citationCount: number;
  taskMessageCount: number;
  memoryLeakMessageIds: string[];
  timedOut: boolean;
  elapsedMs: number;
  terminationReason: EpisodeTerminationReason;
  runtimeErrorCount: number;
  memoryRequestCount?: number;
  memoryRequestMessageIds?: string[];
  offerMessageIds?: string[];
  dispositions?: MemoryDispositionRecord[];
  memoryHintIds?: string[];
  memoryReplyMessageIds?: string[];
  /** Local observation timestamps, in Unix milliseconds. */
  lastRuntimeErrorAt?: number;
  lastProgressAt?: number;
};

/** Classifies an existing exit; does not change the channel-output budgets or final output. */
export function episodeTerminationReason(
  exit: Exclude<EpisodeTerminationReason, "runtime_failed">,
  hasOffer: boolean,
  runtime?: { taskFailed: boolean; memoryFailed: boolean },
): EpisodeTerminationReason {
  if (exit !== "final_settled" && (runtime?.taskFailed || (!hasOffer && runtime?.memoryFailed)))
    return "runtime_failed";
  return exit;
}

/** Local provider observations only. Error text and model/request metadata are never retained.
 * Pi's normalized error events are terminal errors after SDK retries, not individual 502s. */
export function createEpisodeRuntimeDiagnostics() {
  let runtimeErrorCount = 0;
  let lastRuntimeErrorAt: number | undefined;
  let lastProgressAt: number | undefined;
  const failed = { task: false, memory: false };
  const running = { task: false, memory: false };
  return {
    reset(options: { awaitInitialTurns?: boolean } = {}) {
      runtimeErrorCount = 0;
      lastRuntimeErrorAt = undefined;
      lastProgressAt = undefined;
      failed.task = failed.memory = false;
      running.task = running.memory = options.awaitInitialTurns ?? false;
    },
    observe(role: "task" | "memory", event: AgentRuntimeEvent, observedAt = Date.now()) {
      if (event.type === "error") {
        runtimeErrorCount += 1;
        lastRuntimeErrorAt = observedAt;
      }
      if (event.type === "completed") {
        failed[role] = event.status === "failed";
        running[role] = false;
      }
      if (
        event.type === "progress" ||
        event.type === "text-delta" ||
        event.type === "thinking-delta" ||
        event.type === "tool-start"
      )
        running[role] = true;
      if (
        event.type === "progress" ||
        event.type === "text-delta" ||
        event.type === "thinking-delta" ||
        (event.type === "tool-end" && !event.isError)
      ) {
        failed[role] = false;
        lastProgressAt = observedAt;
      }
    },
    snapshot() {
      return {
        runtimeErrorCount,
        ...(lastRuntimeErrorAt === undefined ? {} : { lastRuntimeErrorAt }),
        ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
        taskFailed: failed.task,
        memoryFailed: failed.memory,
        taskRunning: running.task,
        memoryRunning: running.memory,
      };
    },
  };
}

/** The human addresses both agents. Memory starts task-based retrieval;
 * Task may request follow-ups. Only Memory retrieves and returns cited Offers. */
export async function runEpisode(input: {
  workspace: EvalWorkspace;
  env: EvalEnv;
  episode: ManifestEpisode;
  reminder: string;
  episodeTimeoutMs: number;
  settleMs: number;
  runtimeDiagnostics?: ReturnType<typeof createEpisodeRuntimeDiagnostics>;
}): Promise<EpisodeResult> {
  const startedAt = Date.now();
  input.runtimeDiagnostics?.reset({ awaitInitialTurns: true });
  const posted = await postEpisodePrompt({
    workspace: input.workspace,
    redisUrl: input.env.redisUrl,
    episode: input.episode,
    reminder: input.reminder,
    envNote: input.env.envNote,
  });
  const deadline = Date.now() + input.episodeTimeoutMs;
  const abortQuietMs = input.env.abortQuietMs;
  let snapshot = {
    finalOutput: null as string | null,
    offerMessageId: null as string | null,
    citationCount: 0,
    taskMessageCount: 0,
    memoryLeakMessageIds: [] as string[],
    timedOut: false,
    memoryRequestCount: 0,
    memoryRequestMessageIds: [] as string[],
    offerMessageIds: [] as string[],
    dispositions: [] as MemoryDispositionRecord[],
    memoryHintIds: [] as string[],
    memoryReplyMessageIds: [] as string[],
  };
  const finish = (exit: Exclude<EpisodeTerminationReason, "runtime_failed">): EpisodeResult => {
    const runtime = input.runtimeDiagnostics?.snapshot();
    return {
      ...snapshot,
      timedOut: exit !== "final_settled",
      elapsedMs: Date.now() - startedAt,
      terminationReason: episodeTerminationReason(exit, snapshot.offerMessageId !== null, runtime),
      runtimeErrorCount: runtime?.runtimeErrorCount ?? 0,
      ...(runtime?.lastRuntimeErrorAt === undefined
        ? {}
        : { lastRuntimeErrorAt: runtime.lastRuntimeErrorAt }),
      ...(runtime?.lastProgressAt === undefined ? {} : { lastProgressAt: runtime.lastProgressAt }),
    };
  };
  while (Date.now() < deadline) {
    const offers = await input.workspace.db.memoryOfferRecord.findMany({
      where: {
        workspaceId: input.workspace.workspaceId,
        conversationId: input.workspace.channelId,
        createdAt: { gt: posted.createdAt },
      },
      include: { citations: true },
      orderBy: { createdAt: "desc" },
    });
    const taskMessages = await input.workspace.db.message.findMany({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: posted.createdAt },
        sender: { agentId: input.workspace.taskAgentId },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        body: true,
        createdAt: true,
        mentions: { select: { kind: true, actorId: true } },
      },
    });
    const memoryMessages = await input.workspace.db.message.findMany({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: posted.createdAt },
        sender: { agentId: input.workspace.memoryAgentId },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true },
    });
    const hints = await input.workspace.db.memoryHintRecord.findMany({
      where: {
        workspaceId: input.workspace.workspaceId,
        conversationId: input.workspace.channelId,
        targetAgentId: input.workspace.taskAgentId,
        deliveredAt: { gt: posted.createdAt },
      },
      include: { dispositions: { orderBy: { sequence: "asc" } } },
    });
    const requests = taskMessages.filter((message) => {
      const finalIrAnswer =
        input.episode.domain === "information_retrieval" &&
        /(?:^|\n)Exact Answer:/i.test(message.body) &&
        /(?:^|\n)Confidence:/i.test(message.body);
      return (
        !finalIrAnswer &&
        message.mentions.some(
          (mention) =>
            mention.kind === "agent" && mention.actorId === input.workspace.memoryAgentId,
        )
      );
    });
    const requestIds = new Set(requests.map((message) => message.id));
    const answers = taskMessages.filter((message) => !requestIds.has(message.id));
    const offerIds = new Set(offers.map((offer) => offer.messageId));
    snapshot = {
      finalOutput: answers.at(-1)?.body ?? null,
      offerMessageId: offers[0]?.messageId ?? null,
      citationCount: new Set(
        offers.flatMap((offer) => offer.citations.map((citation) => citation.citationId)),
      ).size,
      taskMessageCount: taskMessages.length,
      memoryLeakMessageIds: [],
      memoryReplyMessageIds: memoryMessages.map((row) => row.id).filter((id) => !offerIds.has(id)),
      timedOut: false,
      memoryRequestCount: requests.length,
      memoryRequestMessageIds: [...requestIds],
      offerMessageIds: [...offerIds],
      memoryHintIds: hints.map((hint) => hint.id),
      dispositions: hints.flatMap((hint) =>
        hint.dispositions.map((record) => ({
          hint_id: hint.id,
          target_agent_id: record.targetAgentId,
          decision: record.decision as MemoryDispositionRecord["decision"],
          reason: record.reason,
          intended_action_refs: record.intendedActionRefs,
          decided_at: record.decidedAt.toISOString(),
          skipped_source_refs: record.skippedSourceRefs,
        })),
      ),
    };
    const lastTaskAt = taskMessages.at(-1)?.createdAt?.getTime() ?? 0;
    const lastAnswer = answers.at(-1);
    const answerIsLastTaskMessage = lastAnswer?.id === taskMessages.at(-1)?.id;
    const runtime = input.runtimeDiagnostics?.snapshot();
    const lastMemoryAt = memoryMessages.at(-1)?.createdAt.getTime() ?? 0;
    const lastHintAt = Math.max(0, ...hints.map((hint) => hint.deliveredAt?.getTime() ?? 0));
    const lastInteractionAt = Math.max(
      lastTaskAt,
      lastMemoryAt,
      lastHintAt,
      runtime?.lastProgressAt ?? 0,
    );
    if (
      lastAnswer &&
      answerIsLastTaskMessage &&
      !runtime?.taskRunning &&
      !runtime?.memoryRunning &&
      Date.now() - lastInteractionAt >= input.settleMs
    ) {
      const pending = await input.workspace.db.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM (${unreadAgentMessagesFragment(input.workspace.workspaceId, input.workspace.memoryAgentId)}) unread
        WHERE "conversationId" = ${input.workspace.channelId}::uuid`;
      if (pending[0]?.count === 0) return finish("final_settled");
    }
    // An @memory request is work in progress, not a candidate final answer.
    const progressAt = input.runtimeDiagnostics?.snapshot().lastProgressAt ?? 0;
    if (
      Date.now() - Math.max(posted.createdAt.getTime(), lastTaskAt, lastMemoryAt, progressAt) >=
      abortQuietMs
    ) {
      return finish("quiet_no_offer");
    }
    await delay(input.env.pollMs);
  }
  return finish("deadline");
}
