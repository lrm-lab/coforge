import type { AgentDeliveryPush } from "#src/server/conversations/agent-delivery.server";
import { AGENT_EVENT_MESSAGE_MAX_LENGTH } from "#src/features/apps/app-agent-events";
import type { StoredAgentEvent } from "./agent-events.server";
import { systemEventBody, type SystemEventMessage } from "./event-message.server";
import { systemEventTarget, type SystemEventSource } from "./app-event-target.server";

export type SystemAgentEventWrite = {
  source: SystemEventSource;
  workspaceId: string;
  agentId: string;
  externalEventId: string;
  expiresAt: Date;
  body: string;
};

export interface SystemAgentEventStore {
  expiryAfter(ttlSeconds: number): Promise<Date>;
  exists(source: SystemEventSource, agentId: string, externalEventId: string): Promise<boolean>;
  write(input: SystemAgentEventWrite): Promise<StoredAgentEvent | undefined>;
}

const NOTICE_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SystemNotice = {
  source: SystemEventSource;
  sourceName: string;
  workspaceId: string;
  agentId: string;
  key: string;
  message: Omit<SystemEventMessage, "sourceName">;
};

export class SystemAgentEvents {
  constructor(
    private readonly store: SystemAgentEventStore,
    private readonly push: (workspaceId: string, push: AgentDeliveryPush) => Promise<void>,
  ) {}

  async deliver(notice: SystemNotice): Promise<void> {
    if (await this.store.exists(notice.source, notice.agentId, notice.key)) return;
    const body = systemEventBody({ sourceName: notice.sourceName, ...notice.message });
    if (body.length > AGENT_EVENT_MESSAGE_MAX_LENGTH)
      throw new Error("a notice would be longer than a message may be");
    const stored = await this.store.write({
      source: notice.source,
      workspaceId: notice.workspaceId,
      agentId: notice.agentId,
      externalEventId: notice.key,
      expiresAt: await this.store.expiryAfter(NOTICE_TTL_SECONDS),
      body,
    });
    if (!stored) return;
    await this.push(notice.workspaceId, {
      computerId: stored.computerId,
      requestId: stored.messageId,
      conversationId: stored.conversationId,
      agentId: notice.agentId,
      messageId: stored.messageId,
      deliveryId: stored.deliveryId,
      sequence: stored.sequence,
      createdAtMs: stored.createdAtMs,
      body,
      mentions: [],
      target: systemEventTarget(notice.source),
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
      attachmentCount: 0,
      source: "app",
    }).catch(() => {});
  }
}
