import {
  AGENT_EVENT_KIND_SCOPE,
  AGENT_EVENT_MESSAGE_MAX_LENGTH,
  type AgentEventInput,
} from "#src/features/apps/app-agent-events";
import type { AgentDeliveryPush } from "#src/server/conversations/agent-delivery.server";
import { agentEventBody, payloadHash } from "./event-message.server";
import { appEventTarget } from "./app-event-target.server";

/** What the store writes for one accepted event. */
export type AgentEventWrite = {
  app: { id: string; key: string };
  workspaceId: string;
  agentId: string;
  kind: AgentEventInput["kind"];
  summary: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  externalEventId: string | null;
  expiresAt: Date;
  /** The Message body the Agent reads. */
  body: string;
};

/** A written event: its Message in the dedicated conversation, and its one delivery. */
export type StoredAgentEvent = {
  eventId: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  deliveryId: string;
  /** The Computer to push the delivery to; none when the Agent is stopped or has no Computer. */
  computerId: string | null;
};

export interface AgentEventStore {
  /** The moment `ttlSeconds` from now on the database clock, the one clock an event's expiry is
   * written and judged by. */
  expiryAfter(ttlSeconds: number): Promise<Date>;
  /** The id of the app's event for the Agent with `externalEventId`. */
  find(appId: string, agentId: string, externalEventId: string): Promise<string | undefined>;
  /** Writes the dedicated conversation (first event), the Agent's membership, the Message with its
   * delivery and the event row in one transaction. `undefined`: an event with the same external id
   * was written meanwhile. */
  write(input: AgentEventWrite): Promise<StoredAgentEvent | undefined>;
}

export type AgentEventResult =
  | { status: "queued"; eventId: string }
  | { status: "deduped"; eventId: string }
  /** The token lacks the scope this kind needs. */
  | { status: "insufficient_scope"; scope: string }
  /** The event names another Agent than its token's. */
  | { status: "other_agent" }
  /** The event, as a Message, would be longer than a message may be. */
  | { status: "too_large" };

/** The app that sent an event, the Agent and Workspace its token is bound to, and the scopes it holds. */
export type AgentEventSender = {
  appId: string;
  appKey: string;
  appName: string;
  workspaceId: string;
  agentId: string;
  scopes: readonly string[];
};

/**
 * An app's event for one Agent. The Agent and Workspace are the token's; the event may restate the
 * Agent but never change it. An accepted event becomes one Message in the app's dedicated
 * conversation with the Agent (`@app.<key>`) and is delivered like any other Message: it wakes the
 * Agent through the daemon's notice, and, if the notice is lost, comes back from the cloud read
 * boundary. A retry with the same external id answers the first event and delivers nothing.
 */
export class AgentEvents {
  constructor(
    private readonly store: AgentEventStore,
    /** Pushes the committed delivery to the Agent's daemon. Best effort: the Message and its
     * delivery are stored, so a failed push is repaired by the cloud read boundary. */
    private readonly push: (workspaceId: string, push: AgentDeliveryPush) => Promise<void>,
  ) {}

  async accept(sender: AgentEventSender, input: AgentEventInput): Promise<AgentEventResult> {
    if (input.agentId && input.agentId !== sender.agentId) return { status: "other_agent" };
    const scope = AGENT_EVENT_KIND_SCOPE[input.kind];
    if (!sender.scopes.includes(scope)) return { status: "insufficient_scope", scope };
    if (input.externalEventId) {
      const original = await this.store.find(sender.appId, sender.agentId, input.externalEventId);
      if (original) return { status: "deduped", eventId: original };
    }
    const hash = payloadHash(input.payload);
    const expiresAt = await this.store.expiryAfter(input.ttlSeconds);
    const body = agentEventBody({
      app: { key: sender.appKey, name: sender.appName },
      kind: input.kind,
      summary: input.summary,
      payload: input.payload,
      payloadHash: hash,
      expiresAt,
    });
    if (body.length > AGENT_EVENT_MESSAGE_MAX_LENGTH) return { status: "too_large" };
    const stored = await this.store.write({
      app: { id: sender.appId, key: sender.appKey },
      workspaceId: sender.workspaceId,
      agentId: sender.agentId,
      kind: input.kind,
      summary: input.summary,
      payload: input.payload,
      payloadHash: hash,
      externalEventId: input.externalEventId,
      expiresAt,
      body,
    });
    if (!stored) {
      const original = input.externalEventId
        ? await this.store.find(sender.appId, sender.agentId, input.externalEventId)
        : undefined;
      if (!original) throw new Error("an Agent event with the same external id vanished");
      return { status: "deduped", eventId: original };
    }
    await this.push(sender.workspaceId, {
      computerId: stored.computerId,
      requestId: stored.messageId,
      conversationId: stored.conversationId,
      agentId: sender.agentId,
      messageId: stored.messageId,
      deliveryId: stored.deliveryId,
      sequence: stored.sequence,
      body,
      mentions: [],
      target: appEventTarget(sender.appKey),
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
    }).catch(() => {});
    return { status: "queued", eventId: stored.eventId };
  }
}
