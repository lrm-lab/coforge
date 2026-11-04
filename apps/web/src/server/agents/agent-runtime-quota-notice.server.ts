import type { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";

/** The one system-message kind a no-reset quota exhaustion posts, so a repeated observation of
 * the same episode (same fingerprint) is not told twice. */
const QUOTA_NOTICE_KIND = "agent_runtime.quota_exhausted";

/** The system message the owner's DM with an exhausted Agent gets — the no-reset
 * `billing_exhausted` classification means no wait can help: switch the runtime or wait for the
 * quota to reset. It wakes no Agent; it is for the person who owns it. */
export async function noteAgentRuntimeQuotaNotice(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string; fingerprint: string },
) {
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { id: true, ownerId: true, runtimeConfig: true },
  });
  if (!agent) return;
  const provider = (agent.runtimeConfig as { runtime?: RuntimeProvider } | null)?.runtime;
  const providerText = provider ? runtimeProviderLabel(provider) : "the runtime";
  const body = `[CoForge paused] ${providerText}'s usage quota is exhausted with no known reset — the Agent stays offline until the runtime is switched or the quota resets.`;
  const conversation = await db.conversation.findFirst({
    where: {
      workspaceId: input.workspaceId,
      directKey: agentDirectKey(agent.ownerId, agent.id),
    },
    select: { id: true },
  });
  if (!conversation) return;
  await db.$transaction(async (tx) => {
    await lockConversation(tx, conversation.id);
    // One exhaustion episode (one fingerprint) is told once; the next exhaustion is a new one.
    const told = await tx.message.findFirst({
      where: {
        conversationId: conversation.id,
        senderMemberId: null,
        systemMessage: {
          kind: QUOTA_NOTICE_KIND,
          params: { path: ["fingerprint"], equals: input.fingerprint },
        },
      },
      select: { id: true },
    });
    if (told) return;
    const sequence = await allocateSequence(tx, conversation.id);
    const message = await tx.message.create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        sequence,
        body,
      },
    });
    await tx.systemMessage.create({
      data: {
        messageId: message.id,
        conversationId: conversation.id,
        workspaceId: input.workspaceId,
        kind: QUOTA_NOTICE_KIND,
        params: { fingerprint: input.fingerprint, provider },
      },
    });
  });
}
