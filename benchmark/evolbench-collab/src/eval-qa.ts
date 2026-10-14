import { RedisClient } from "bun";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { PublicChannels } from "../../../apps/web/src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "../../../apps/web/src/server/conversations/redis-message-request-idempotency.server";
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
  return `@memory ${episode.prompt}${note}\n\n${reminder}`;
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
      return { triggerId, createdAt: new Date() };
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
  return {
    reset() {
      runtimeErrorCount = 0;
      lastRuntimeErrorAt = undefined;
      lastProgressAt = undefined;
      failed.task = failed.memory = false;
    },
    observe(role: "task" | "memory", event: AgentRuntimeEvent, observedAt = Date.now()) {
      if (event.type === "error") {
        runtimeErrorCount += 1;
        lastRuntimeErrorAt = observedAt;
      }
      if (event.type === "completed") failed[role] = event.status === "failed";
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
      };
    },
  };
}

/** One episode: the prompt goes to @memory; the Memory Agent publishes its
 * recall offer addressed to the Task Agent; the Task Agent executes and posts
 * the final answer. The reply is final after the settle window of quiet. */
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
  input.runtimeDiagnostics?.reset();
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
    const offer = await input.workspace.db.memoryOfferRecord.findFirst({
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
      select: { id: true, body: true, createdAt: true },
    });
    const memoryMessages = await input.workspace.db.message.findMany({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: posted.createdAt },
        sender: { agentId: input.workspace.memoryAgentId },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    snapshot = {
      finalOutput: taskMessages.at(-1)?.body ?? null,
      offerMessageId: offer?.messageId ?? null,
      citationCount: offer?.citations.length ?? 0,
      taskMessageCount: taskMessages.length,
      memoryLeakMessageIds: memoryMessages
        .map((row) => row.id)
        .filter((id) => id !== offer?.messageId),
      timedOut: false,
    };
    const lastTaskAt = taskMessages.at(-1)?.createdAt?.getTime() ?? 0;
    // This is a channel-output budget, not a claim that the agents are inactive.
    // Shell work or model generation does not extend the no-Offer budget.
    const deadQuiet =
      snapshot.offerMessageId === null &&
      Date.now() - Math.max(posted.createdAt.getTime(), lastTaskAt) >= abortQuietMs;
    if (deadQuiet) {
      return finish("quiet_no_offer");
    }
    const offeredAndQuiet =
      snapshot.offerMessageId !== null &&
      snapshot.taskMessageCount > 0 &&
      Date.now() - lastTaskAt >= input.settleMs;
    // Without an offer we ride to the deadline: the memory agent may be slow,
    // and an answer that arrived without recall is still recorded (the grader
    // judges it) while the mechanism columns expose the missing recall.
    if (offeredAndQuiet) {
      return finish("final_settled");
    }
    await delay(input.env.pollMs);
  }
  return finish("deadline");
}
