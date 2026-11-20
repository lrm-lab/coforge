import { getLogger } from "@logtape/logtape";
import type { MessageSenderKind, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { isCardEvent } from "./agent-message-attention-index-helpers";

export type NoticeMessage = Readonly<{
  conversationId: string;
  messageId: string;
  target?: string;
  reason?: string;
  mentionDelivery?: unknown;
  latestSenderKind?: MessageSenderKind;
  createdAtMs?: number;
  source?: "app";
  mentionsAgent?: boolean;
  nonMemberMention?: boolean;
  taskDiscussion?: boolean;
}>;

type Context = {
  provider: RuntimeProvider;
  sessionId: string;
  token: object;
  messages: NoticeMessages;
};

type NoticeMessages = Map<string, NoticeMessage>;

const logger = getLogger(["coforge", "daemon", "message-attention"]);
const ACCEPTED_NOTICE_LIMIT = 2048;

export function noticeMessageKey(message: Pick<NoticeMessage, "conversationId" | "messageId">) {
  return JSON.stringify([message.conversationId, message.messageId]);
}

export function isOrdinaryNotice(message: NoticeMessage): boolean {
  return !message.mentionDelivery && !isCardEvent(message);
}

export class AcceptedMessageNotices {
  readonly #previous = new Map<string, Context>();
  readonly #current = new Map<string, Context>();
  readonly #pending = new Map<string, NoticeMessages>();

  begin(agentId: string): void {
    this.pause(agentId);
    this.#pending.set(agentId, new Map());
  }

  pause(agentId: string): void {
    this.#current.delete(agentId);
    if (this.#pending.delete(agentId)) this.#previous.delete(agentId);
  }

  forget(agentId: string): void {
    this.#previous.delete(agentId);
    this.#current.delete(agentId);
    this.#pending.delete(agentId);
  }

  confirm(agentId: string, provider: RuntimeProvider, sessionId: string, resumed: boolean): void {
    const pending = this.#pending.get(agentId);
    const previous = this.#previous.get(agentId);
    const messages =
      resumed && previous?.provider === provider && previous.sessionId === sessionId
        ? previous.messages
        : new Map();
    if (messages.size > 0)
      logger.info("Agent resumed with accepted message identities", {
        event: "agent.message.notice_context_resumed",
        agent_id: agentId,
        daemon_pid: process.pid,
        retained_message_count: messages.size,
      });
    if (pending) this.#record(messages, pending.values());
    this.#pending.delete(agentId);
    const context = { provider, sessionId, token: pending ?? {}, messages };
    this.#previous.set(agentId, context);
    this.#current.set(agentId, context);
  }

  reset(agentId: string): void {
    const current = this.#current.get(agentId);
    this.forget(agentId);
    if (current) this.confirm(agentId, current.provider, current.sessionId, false);
  }

  has(agentId: string, message: NoticeMessage): boolean {
    return (
      isOrdinaryNotice(message) &&
      this.#current.get(agentId)?.messages.has(noticeMessageKey(message)) === true
    );
  }

  acceptance(agentId: string): (messages: readonly NoticeMessage[]) => boolean {
    const context = this.#current.get(agentId);
    const pending = this.#pending.get(agentId);
    const token = context?.token ?? pending;
    return (messages) => {
      const current = this.#current.get(agentId);
      const active = current?.token === token ? current?.messages : undefined;
      const writing = this.#pending.get(agentId);
      const destination = active ?? (writing === token ? writing : undefined);
      if (!destination) return token === undefined && !current && !writing;
      this.#record(destination, messages);
      return true;
    };
  }

  #record(destination: NoticeMessages, messages: Iterable<NoticeMessage>): void {
    for (const message of messages) {
      if (!isOrdinaryNotice(message)) continue;
      const key = noticeMessageKey(message);
      destination.delete(key);
      destination.set(key, {
        conversationId: message.conversationId,
        messageId: message.messageId,
        target: message.target,
      });
    }
    for (const key of destination.keys()) {
      if (destination.size <= ACCEPTED_NOTICE_LIMIT) break;
      destination.delete(key);
    }
  }

  prune(agentId: string, remove: (message: NoticeMessage) => boolean): void {
    const messages = this.#previous.get(agentId)?.messages;
    if (!messages) return;
    for (const [key, message] of messages) if (remove(message)) messages.delete(key);
  }
}
