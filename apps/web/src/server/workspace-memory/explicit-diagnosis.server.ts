import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import { createExplicitMemoryDiagnosis, type DiagnosisScope } from "./explicit-diagnosis";
import { createOpenVikingExplicitDiagnosis } from "#src/server/openviking/explicit-diagnosis.server";
import { createOpenVikingRuntimeClient } from "#src/server/openviking/runtime-client.server";
import { PrismaOpenVikingBindingStore } from "#src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "#src/server/db/repositories/workspace-memory-profile.repositories.server";
import { isOpenVikingWorkspaceReady } from "#src/server/openviking/policy-gateway.server";
import type { MemoryCitationBindings } from "./memory-citations";
import type { MemoryOffers } from "./memory-offers";

import { isExplicitMemoryDiagnosis } from "./explicit-memory-answer";
const MAX_MESSAGES = 64;
const MAX_CHARACTERS = 64000;

export function createPrismaExplicitMemoryDiagnosis(input: {
  db: PrismaClient;
  citations: MemoryCitationBindings;
  offers: MemoryOffers;
  authorization(credentialRef: string): Promise<string>;
}) {
  const { db } = input;
  const bindings = new PrismaOpenVikingBindingStore(db);
  const profiles = new PrismaWorkspaceMemoryProfileStore(db);
  const run = createOpenVikingExplicitDiagnosis({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: Bun.env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:0",
    }),
    async identity(workspaceId, targetAgentId) {
      const binding = await bindings.get(workspaceId);
      if (!binding || !isOpenVikingWorkspaceReady(await profiles.get(workspaceId), binding))
        throw new Error("diagnosis_workspace_unavailable");
      return {
        accountId: binding.accountId,
        userId: `agent:${targetAgentId}`,
        role: "user",
        authorization: await input.authorization(binding.credentialRef),
      };
    },
  });
  return createExplicitMemoryDiagnosis({
    async resolve({ workspaceId, agentId, messageId }): Promise<DiagnosisScope> {
      const ttl = Number(Bun.env.COFORGE_MEMORY_HINT_TTL_SECONDS);
      if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("diagnosis_hint_ttl_required");
      const question = await db.message.findFirst({
        where: { id: messageId, workspaceId },
        include: { sender: true, mentions: MESSAGE_MENTIONS_SELECT, conversation: true },
      });
      if (
        !question ||
        !question.sender?.agentId ||
        question.sender.agentId === agentId ||
        !question.conversation.channelName ||
        question.conversation.archivedAt ||
        !isExplicitMemoryDiagnosis(question.body, agentId)
      )
        throw new Error("diagnosis_scope_denied");
      const targetAgentId = question.sender.agentId;
      const members = await db.conversationMember.count({
        where: {
          workspaceId,
          conversationId: question.conversationId,
          leftAt: null,
          agentId: { in: [agentId, targetAgentId] },
        },
      });
      if (members !== 2) throw new Error("diagnosis_scope_denied");
      const rows = await db.message.findMany({
        where: {
          workspaceId,
          conversationId: question.conversationId,
          sequence: { lte: question.sequence },
          ...(question.threadRootId
            ? { OR: [{ threadRootId: question.threadRootId }, { id: question.threadRootId }] }
            : { threadRootId: null }),
        },
        orderBy: { sequence: "desc" },
        take: MAX_MESSAGES,
        include: { sender: { include: { agent: true } }, mentions: MESSAGE_MENTIONS_SELECT },
      });
      let remaining = MAX_CHARACTERS;
      const messages = [];
      for (const row of rows) {
        const content = agentMessageView(row).body;
        if (content.length > remaining) break;
        remaining -= content.length;
        messages.push({
          role: row.sender?.agentId ? ("assistant" as const) : ("user" as const),
          content,
          createdAt: row.createdAt.toISOString(),
          sourceMessageIds: [row.id],
          ...(row.sender?.agentId
            ? { peerId: `coforge__${row.sender.agent?.name ?? row.sender.agentId}` }
            : {}),
        });
      }
      if (!messages.length) throw new Error("diagnosis_evidence_budget_exceeded");
      return {
        requestId: question.id,
        conversationId: question.conversationId,
        targetAgentId,
        question: agentMessageView(question).body,
        messages: messages.reverse(),
      };
    },
    run,
    async notifyFailure({ workspaceId, agentId, scope, reason }) {
      const [group, target] = await Promise.all([
        db.conversation.findFirstOrThrow({
          where: { id: scope.conversationId, workspaceId },
          select: { channelName: true },
        }),
        db.agent.findFirstOrThrow({
          where: { id: scope.targetAgentId, workspaceId },
          select: { name: true },
        }),
      ]);
      const api = createCentrifugoServerApi();
      const sender = new SendDirectMessage(
        new PrismaDirectConversationRepository(db),
        getMessageRequestIdempotency(),
        api,
        new CentrifugoConversationRealtime(api),
      );
      const safeReason = /^[a-z_]+$/.test(reason) ? reason : "diagnosis_failed";
      const result = await sender.executeFromAgent({
        workspaceId,
        agentId,
        target: `#${group.channelName}`,
        idempotencyKey: `diagnosis-status:${scope.requestId}:failed`,
        body: `@${target.name} 四角色诊断未完成（${safeReason}）。本次没有交付诊断建议，也没有执行修复。求助消息：${scope.requestId}`,
        mentions: [{ type: "agent", id: scope.targetAgentId, name: target.name }],
      });
      return result.id;
    },
    async publish({ workspaceId, agentId, scope, result, body }) {
      const binding = await bindings.get(workspaceId);
      if (!binding) throw new Error("diagnosis_workspace_unavailable");
      const citations = await input.citations.bindOpenVikingHits(
        workspaceId,
        `diagnosis-${scope.requestId}`,
        [
          {
            accountId: binding.accountId,
            uri: result.report_uri,
            contentHash: result.content_hash,
            citationId: `ov:diagnosis:${scope.requestId}`,
            matchedLevel: "L2",
            title: "Four-role diagnosis report",
          },
        ],
      );
      const delivered = await input.offers.publish({
        workspaceId,
        memoryAgentId: agentId,
        operationId: `diagnosis-${scope.requestId}`,
        conversationId: scope.conversationId,
        targetAgentId: scope.targetAgentId,
        recipientRationale: "answers this agent's explicit diagnosis request",
        citationRefs: citations.map((citation) => citation.citationId),
        body,
      });
      return { duplicate: delivered.duplicate, messageId: delivered.offer.messageId };
    },
  });
}
