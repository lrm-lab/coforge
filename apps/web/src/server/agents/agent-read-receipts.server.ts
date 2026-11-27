import {
  AGENT_READ_PROTOCOL,
  type AgentReadCheckpoint,
  type AgentReadConfirmation,
  type AgentReadPageRequest,
} from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import {
  matchesValueProof,
  readSignedValue,
  signValue,
  signValueProof,
} from "#src/server/auth/signed-value.server";

const PAGE_PURPOSE = "agent-read-page:v1";
const CHECKPOINT_PURPOSE = "agent-read-checkpoint:v1";
const RECEIPT_LIFETIME_MS = 10 * 60_000;

export type AgentReadPrincipal = { workspaceId: string; agentId: string };
export type AgentReadSource = AgentReadPageRequest["source"];

export type AgentReadScope = {
  agentId: string;
  conversationId: string;
  threadRootId?: string;
  target: string;
  channelType: "dm" | "channel" | "thread";
};

export type ReadScopeAuthority = {
  scope: AgentReadScope;
  taskId?: string;
  boardMemberId?: string;
  publishConversationRead?: boolean;
};

type CheckpointPosition = Omit<AgentReadCheckpoint, "proof">;
export type ReadConfirmation = AgentReadConfirmation;

type ReadTicket = AgentReadPrincipal & {
  protocol: typeof AGENT_READ_PROTOCOL;
  pageId: string;
  expiresAt: number;
  source: AgentReadSource;
  scope: AgentReadScope;
  memberId: string | null;
  base: number;
  length: number;
  end: number;
};

export function sameReadScope(a: AgentReadScope, b: AgentReadScope) {
  return (
    a.agentId === b.agentId &&
    a.conversationId === b.conversationId &&
    a.threadRootId === b.threadRootId &&
    a.target === b.target &&
    a.channelType === b.channelType
  );
}

function checkpointPayload(pageId: string, { index, through, messageId }: CheckpointPosition) {
  return { pageId, index, through, messageId };
}

export function signAgentReadPage(
  secret: string,
  input: {
    principal: AgentReadPrincipal;
    source: AgentReadSource;
    scope: AgentReadScope;
    memberId: string | null;
    readThrough: number;
    checkpoints: readonly number[];
    messages: readonly { id: string }[];
  },
  now: number,
): ReadConfirmation {
  const { principal, source, scope, memberId, readThrough, checkpoints, messages } = input;
  const ticket: ReadTicket = {
    ...principal,
    protocol: AGENT_READ_PROTOCOL,
    pageId: crypto.randomUUID(),
    expiresAt: now + RECEIPT_LIFETIME_MS,
    source,
    scope,
    memberId,
    base: readThrough,
    length: checkpoints.length,
    end: checkpoints.at(-1)!,
  };
  return {
    page: signValue(PAGE_PURPOSE, ticket, secret),
    checkpoints: checkpoints.map((through, offset) => {
      const messageId = messages[offset]?.id;
      const position = { index: offset + 1, through, ...(messageId && { messageId }) };
      return {
        ...position,
        proof: signValueProof(
          CHECKPOINT_PURPOSE,
          checkpointPayload(ticket.pageId, position),
          secret,
        ),
      };
    }),
  };
}

export function verifyAgentReadConfirmation(
  secret: string,
  principal: AgentReadPrincipal,
  confirmation: ReadConfirmation,
  now: number,
) {
  const ticket = readSignedValue<ReadTicket>(PAGE_PURPOSE, confirmation.page, secret);
  if (
    !ticket ||
    ticket.protocol !== AGENT_READ_PROTOCOL ||
    ticket.agentId !== principal.agentId ||
    ticket.workspaceId !== principal.workspaceId ||
    ticket.expiresAt <= now ||
    confirmation.checkpoints.length === 0 ||
    confirmation.checkpoints.length > ticket.length
  )
    throw new AppError("INVALID_INPUT");

  let through = ticket.base;
  for (const [index, checkpoint] of confirmation.checkpoints.entries()) {
    if (
      checkpoint.index !== index + 1 ||
      checkpoint.through < through ||
      checkpoint.through > ticket.end ||
      !matchesValueProof(
        CHECKPOINT_PURPOSE,
        checkpointPayload(ticket.pageId, checkpoint),
        checkpoint.proof,
        secret,
      )
    )
      throw new AppError("INVALID_INPUT");
    through = checkpoint.through;
  }
  return { ...ticket, through };
}
