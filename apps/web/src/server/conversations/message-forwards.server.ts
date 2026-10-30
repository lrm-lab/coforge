import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import type {
  ForwardDestinationResult,
  ForwardFailureCode,
  ForwardMessageResult,
} from "#src/features/conversations/message-forward";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { ManagedFileStorage } from "#src/server/files/file-storage.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { agentForwarded } from "./agent-message-view.server";
import { sendChannel } from "./channel-send.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { DirectConversations } from "./direct-conversations.server";
import { loadForwardSource, type ForwardSource } from "./message-forward-source.server";
import { recordForward } from "./message-forward-view.server";
import type {
  MessageRequestIdempotency,
  MessageRequestRecords,
  MessageRequestScope,
} from "./message-request-idempotency.server";

export type MessageForwardPorts = {
  db: PrismaClient;
  /** The Redis-backed request idempotency, which can also be read without claiming a key. */
  idempotency: MessageRequestIdempotency & MessageRequestRecords;
  centrifugo: CentrifugoServerApi;
  realtime?: ConversationRealtime;
  notifications?: MessageNotifier;
  /** The store the original's uploads are copied in. */
  storage: () => Promise<ManagedFileStorage>;
  /** Work a send into a direct conversation needs first (an assistant's Computer). */
  prepareDirect?: (workspaceId: string, userId: string, conversationId: string) => Promise<void>;
};

/** The key one destination's send is made under: the forwarder's request id and the destination
 * together, in the UUID shape every send key has. The forwarder is part of the idempotency scope. */
export function forwardIdempotencyKey(requestId: string, destinationId: string): string {
  const bytes = createHash("sha256").update(`forward:${requestId}:${destinationId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A destination's refusal, from the error a send raised. */
function failureOf(error: unknown): ForwardFailureCode {
  if (!isAppError(error)) return "failed";
  switch (error.code) {
    case "CONFLICT":
      return "archived";
    case "ACCESS_DENIED":
    case "NOT_FOUND":
    case "AGENT_DM_RESTRICTED":
    case "DM_PEER_NOT_IN_WORKSPACE":
      return "no_access";
    default:
      return "failed";
  }
}

type Settled = { result: ForwardDestinationResult; replay: boolean };

/**
 * Forwards one message to several conversations. The original is read once, whole, and refused
 * as a whole when it cannot be forwarded; each destination then takes its own send, under the
 * forwarder's normal permission to post there, so one can fail while the rest go through, and a
 * retry under the same request id sends only what failed.
 */
export class MessageForwards {
  constructor(private readonly ports: MessageForwardPorts) {}

  async forward(input: {
    workspaceId: string;
    userId: string;
    requestId: string;
    sourceMessageId: string;
    destinations: readonly string[];
    note?: string;
  }): Promise<ForwardMessageResult> {
    const source = await loadForwardSource(this.ports.db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      messageId: input.sourceMessageId,
    });
    const settled: Settled[] = [];
    // One after another: each copies the original's uploads, and ten at once would hold them all.
    for (const destination of input.destinations)
      settled.push(await this.forwardTo(source, { ...input, destination }));
    const results = settled.map((entry) => entry.result);
    const succeeded = results.filter((result) => result.status === "success").length;
    const outcome =
      succeeded === 0
        ? "all_failed"
        : succeeded < results.length
          ? "partial_failure"
          : settled.every((entry) => entry.replay)
            ? "idempotent_replay"
            : "success";
    return { outcome, results };
  }

  private async forwardTo(
    source: ForwardSource,
    input: {
      workspaceId: string;
      userId: string;
      requestId: string;
      destination: string;
      note?: string;
    },
  ): Promise<Settled> {
    const { workspaceId, userId, destination } = input;
    const failed = (code: ForwardFailureCode): Settled => ({
      result: { destination, status: "failed", error: { code } },
      replay: false,
    });
    const succeeded = (message: { id: string; sequence: number }, replay: boolean): Settled => ({
      result: {
        destination,
        status: "success",
        message: { id: message.id, sequence: message.sequence },
      },
      replay,
    });
    const scope: MessageRequestScope = {
      workspaceId,
      senderKind: "user",
      senderId: userId,
      idempotencyKey: forwardIdempotencyKey(input.requestId, destination),
    };
    // A destination this request already reached answers with the message it made: nothing is
    // copied or sent again. One still being sent by another attempt is left to it.
    const record = await this.ports.idempotency.find(scope);
    if (record?.state === "completed") return succeeded(record.message, true);
    if (record?.state === "processing") return failed("failed");

    const route = await this.route(workspaceId, userId, destination);
    if (route.failure) return failed(route.failure);

    let copies: CopiedAttachments | undefined;
    try {
      copies = await this.copyAttachments(source, { workspaceId, userId, destination });
      const sent = await this.send(route.kind, {
        ...input,
        idempotencyKey: scope.idempotencyKey,
        attachmentIds: copies.ids,
        source,
      });
      return succeeded(sent, false);
    } catch (error) {
      // A send that failed after its message committed (a publication error) still made the
      // message; the key says so, and the copies are then the message's own.
      const committed = await this.ports.idempotency.find(scope).catch(() => undefined);
      if (committed?.state === "completed") return succeeded(committed.message, false);
      await copies?.discard();
      return failed(failureOf(error));
    }
  }

  /** Where a destination goes, or why the forwarder may not post there. */
  private async route(
    workspaceId: string,
    userId: string,
    destination: string,
  ): Promise<{ kind: "channel" | "dm"; failure?: never } | { failure: ForwardFailureCode }> {
    const { db } = this.ports;
    const conversation = await db.conversation.findFirst({
      // Channels and direct conversations only: an attachment's comments and an app's events
      // are no place to forward to.
      where: { id: destination, workspaceId, kind: null, ...VISIBLE_CONVERSATION_WHERE },
      select: {
        channelName: true,
        directKey: true,
        archivedAt: true,
        members: { where: { userId }, select: { id: true, leftAt: true } },
      },
    });
    if (!conversation) return { failure: "no_access" };
    const own = conversation.members[0];
    if (conversation.channelName !== null) {
      if (conversation.archivedAt) return { failure: "archived" };
      // Never joined silently: the client asks the person, joins, and sends again.
      if (!own || own.leftAt) return { failure: "not_joined" };
      return { kind: "channel" };
    }
    if (conversation.directKey === null || !own || own.leftAt) return { failure: "no_access" };
    try {
      await new DirectConversations(db).authorize(workspaceId, userId, destination, {
        canSend: true,
      });
      const peerId = peopleDirectPeerId(conversation.directKey, userId);
      if (peerId && peerId !== userId) {
        const peer = await db.conversationMember.findFirst({
          where: { conversationId: destination, userId: peerId, leftAt: null },
          select: { id: true },
        });
        if (!peer) return { failure: "read_only" };
      }
    } catch (error) {
      // Another person's Agent DM is no access; a deleted Agent's conversation stays readable
      // and takes no new message.
      return {
        failure: isAppError(error) && error.code === "ACCESS_DENIED" ? "no_access" : "read_only",
      };
    }
    return { kind: "dm" };
  }

  private async send(
    kind: "channel" | "dm",
    input: {
      workspaceId: string;
      userId: string;
      destination: string;
      note?: string;
      idempotencyKey: string;
      attachmentIds: string[];
      source: ForwardSource;
    },
  ): Promise<{ id: string; sequence: number }> {
    const { db, idempotency, centrifugo, realtime, notifications } = this.ports;
    const { workspaceId, userId, destination } = input;
    // The snapshot is written in the send's own transaction; the Agent reads the same one.
    const forwarding = {
      withinSend: recordForward(input.source),
      allowEmptyBody: true,
      forwarded: agentForwarded(
        input.source,
        input.attachmentIds.map((id) => ({ id })),
      ),
    };
    if (kind === "channel")
      return sendChannel(
        { db, idempotency, notifications, realtime, publisher: centrifugo },
        {
          workspaceId,
          userId,
          channelId: destination,
          idempotencyKey: input.idempotencyKey,
          body: input.note ?? "",
          attachmentIds: input.attachmentIds,
          ...forwarding,
        },
      );
    await this.ports.prepareDirect?.(workspaceId, userId, destination);
    return new DirectConversations(db).send(
      workspaceId,
      userId,
      destination,
      {
        idempotencyKey: input.idempotencyKey,
        body: input.note ?? "",
        attachmentIds: input.attachmentIds,
        ...forwarding,
      },
      { idempotency, centrifugo, realtime },
    );
  }

  /**
   * Copies the original's uploads for the destination: new objects in storage and new unlinked
   * attachments of the forwarder's in the destination conversation, which the send then links.
   * Neither object touches the other afterwards. A failure leaves nothing behind.
   */
  private async copyAttachments(
    source: ForwardSource,
    scope: { workspaceId: string; userId: string; destination: string },
  ): Promise<CopiedAttachments> {
    const { db } = this.ports;
    const copied: { id: string; objectKey: string }[] = [];
    const discard = async () => {
      if (!copied.length) return;
      const files = await this.ports.storage();
      await db.attachment
        .deleteMany({ where: { id: { in: copied.map((copy) => copy.id) }, messageId: null } })
        .catch(() => undefined);
      await files.removeMany(copied.map((copy) => copy.objectKey)).catch(() => undefined);
    };
    if (!source.attachments.length) return { ids: [], discard };
    try {
      const files = await this.ports.storage();
      for (const original of source.attachments) {
        const id = randomUUID();
        const objectKey = `workspaces/${scope.workspaceId}/attachments/${id}/original`;
        await files.copyObject(original.objectKey, objectKey);
        copied.push({ id, objectKey });
        await db.attachment.create({
          data: {
            id,
            workspaceId: scope.workspaceId,
            conversationId: scope.destination,
            uploaderId: scope.userId,
            objectKey,
            fileName: original.fileName,
            contentType: original.contentType,
            sizeBytes: original.sizeBytes,
            imageWidth: original.imageWidth,
            imageHeight: original.imageHeight,
          },
        });
      }
    } catch (error) {
      await discard();
      throw error;
    }
    return { ids: copied.map((copy) => copy.id), discard };
  }
}

type CopiedAttachments = { ids: string[]; discard: () => Promise<void> };
