import { AGENT_READ_PROTOCOL } from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { ResolvedAgentTarget } from "#src/server/db/repositories/resolved-agent-target.server";
import {
  conversationReadChangedPort,
  type ConversationReadRealtimePort,
} from "#src/server/db/repositories/agent-read-groups.repositories.server";
import { confirmAgentReadPosition } from "#src/server/db/repositories/agent-confirm-read.repositories.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import {
  sameReadScope,
  signAgentReadPage,
  verifyAgentReadConfirmation,
  type AgentReadPrincipal,
  type AgentReadSource,
  type ReadConfirmation,
  type ReadScopeAuthority,
} from "./agent-read-receipts.server";
import type { AgentMessagesPage } from "./agent-messages.server";

type ReadWindow = AgentMessagesPage & { consume?: boolean };

function messageScope(
  principal: AgentReadPrincipal,
  resolved: ResolvedAgentTarget,
): ReadScopeAuthority {
  return {
    scope: {
      agentId: principal.agentId,
      conversationId: resolved.conversationId,
      target: resolved.canonicalTarget,
      ...(resolved.threadRootId && { threadRootId: resolved.threadRootId }),
      channelType:
        resolved.threadRootId || resolved.seatOptional
          ? "thread"
          : resolved.isChannel
            ? "channel"
            : "dm",
    },
    publishConversationRead:
      (resolved.isChannel && !resolved.seatOptional) || resolved.isUserAgentDirectConversation,
  };
}

const taskRef = (source: Extract<AgentReadSource, { kind: "task" }>) => ({
  target: source.channel.replace(/^dm:/, ""),
  number: source.taskNumber,
});

function sameSource(a: AgentReadSource, b: AgentReadSource) {
  if (a.kind === "message") return b.kind === "message" && a.target === b.target;
  return b.kind === "task" && a.channel === b.channel && a.taskNumber === b.taskNumber;
}

export class AgentReads {
  private readonly messages: PrismaDirectConversationRepository;
  private readonly tasks: TaskConversations;

  constructor(
    private readonly db: PrismaClient,
    private readonly secret: string,
    private readonly now = Date.now,
    private readonly realtime?: ConversationReadRealtimePort,
  ) {
    this.messages = new PrismaDirectConversationRepository(db);
    this.tasks = new TaskConversations({ db, reader: "agent", dependencies: {} });
  }

  async page(
    principal: AgentReadPrincipal,
    source: AgentReadSource,
    window: ReadWindow,
    confirm?: ReadConfirmation,
  ) {
    const confirmation = confirm && (await this.confirm(principal, confirm, source));
    const { consume, ...range } = window;
    if (source.kind === "message") {
      const { receiptCandidate, receiptScope, ...result } = await this.messages.readMessagesPage(
        principal.workspaceId,
        principal.agentId,
        source.target,
        { ...range, receiptCandidate: true },
      );
      return this.response(
        principal,
        source,
        range,
        consume,
        confirmation,
        receiptCandidate,
        receiptScope && !receiptScope.seatOptional
          ? messageScope(principal, receiptScope)
          : undefined,
        {
          ...result,
          messages: result.messages.map((message) => ({
            ...message,
            createdAt: message.createdAt.toISOString(),
          })),
        },
      );
    }
    const { receiptCandidate, receiptScope, ...result } = await this.tasks.read(
      principal,
      taskRef(source),
      range,
      true,
    );
    return this.response(
      principal,
      source,
      range,
      consume,
      confirmation,
      receiptCandidate,
      receiptScope && {
        scope: {
          agentId: receiptScope.agentId,
          conversationId: receiptScope.conversationId,
          target: receiptScope.target,
          channelType: receiptScope.channelType,
        },
      },
      result,
    );
  }

  async confirm(
    principal: AgentReadPrincipal,
    input: ReadConfirmation,
    expectedSource?: AgentReadSource,
  ) {
    const ticket = verifyAgentReadConfirmation(this.secret, principal, input, this.now());
    if (expectedSource && !sameSource(expectedSource, ticket.source))
      throw new AppError("INVALID_INPUT");

    let authority: ReadScopeAuthority;
    if (ticket.source.kind === "message") {
      const resolved = await this.messages.resolveAgentTarget(
        principal.workspaceId,
        principal.agentId,
        ticket.source.target,
        true,
      );
      authority = messageScope(principal, resolved);
    } else {
      const { taskId, boardMemberId, ...scope } = await this.tasks.resolveReadConfirmation(
        principal,
        taskRef(ticket.source),
      );
      authority = { scope, taskId, boardMemberId };
    }
    if (!sameReadScope(ticket.scope, authority.scope)) throw new AppError("NOT_FOUND");

    const { readThrough, publication } = await confirmAgentReadPosition(this.db, {
      ...principal,
      conversationId: authority.scope.conversationId,
      threadRootId: authority.scope.threadRootId,
      signedMemberId: ticket.memberId,
      taskId: authority.taskId,
      boardMemberId: authority.boardMemberId,
      base: ticket.base,
      through: ticket.through,
      publishConversationRead: authority.publishConversationRead === true,
    });
    if (publication) void conversationReadChangedPort(this.realtime)?.(publication).catch(() => {});
    return { scope: authority.scope, readThrough };
  }

  private response<T extends { messages: { id: string }[] }>(
    principal: AgentReadPrincipal,
    source: AgentReadSource,
    range: AgentMessagesPage,
    consume: boolean | undefined,
    confirmation: { scope: ReadScopeAuthority["scope"]; readThrough: number } | undefined,
    candidate:
      | { readThrough: number; memberId?: string | null; checkpoints?: number[] }
      | undefined,
    authority: ReadScopeAuthority | undefined,
    window: T,
  ) {
    const readThrough = candidate?.readThrough ?? 0;
    const receipt =
      consume !== false && !range.around && candidate?.checkpoints && authority
        ? signAgentReadPage(
            this.secret,
            {
              principal,
              source,
              scope: authority.scope,
              memberId: candidate.memberId ?? null,
              readThrough,
              checkpoints: candidate.checkpoints,
              messages: window.messages,
            },
            this.now(),
          )
        : undefined;
    return {
      protocol: AGENT_READ_PROTOCOL,
      readThrough,
      window: {
        ...window,
        olderCursor: window.messages[0]?.id,
        newerCursor: window.messages.at(-1)?.id,
      },
      ...(receipt && { receipt }),
      ...(confirmation && { confirmation }),
    };
  }
}
