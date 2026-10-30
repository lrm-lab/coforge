import { publicationDataOrUndefined } from "#src/features/realtime/publication-data";

/**
 * One message, to each person it concerns, on their own channel (`chat:user:<id>`): the data the
 * Chat sidebar needs to write that conversation's row in place (its new last message) and to
 * count the message for the viewer's unread badge and Activity dot. Published only to people who
 * may read the conversation — a channel's active members, or a thread's followers for a reply —
 * so a channel's text never reaches a tab that is not in it, and never to the whole Workspace.
 *
 * The viewer's own messages arrive too (their other tabs and devices must move the row); the page
 * never counts them, and a system message (`sender.kind === "system"`, no sender id) never counts
 * either, exactly as the unread rule in `human-unread.server.ts` says.
 */
export type ConversationActivityEvent = {
  type: "conversation.activity.v1";
  workspaceId: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  /** Which list's row this conversation has: a channel's or a direct message's. */
  kind: "channel" | "direct";
  /** The message's own time (ISO), the row's new last-message time. */
  createdAt: string;
  /** The message body as one line for the row, as the list read gives it. */
  preview: string;
  sender: { kind: "user" | "agent" | "system"; name: string };
  /** The person who wrote it; absent for an Agent's or a system message. */
  senderUserId?: string;
  /** The Agent that wrote it, when an Agent did. */
  senderAgentId?: string;
  /** Set only for a thread reply: the row keeps its last *top-level* message, so a reply lights
   * the Activity dot for the thread's followers but changes no row. */
  threadRootId?: string;
};

/** Undefined for anything else on the channel, binary publications included: `chat:user:` also
 * carries an Agent's reply intent in a direct conversation and Pi chat frames. */
export function decodeConversationActivityEvent(
  input: unknown,
): ConversationActivityEvent | undefined {
  const value = publicationDataOrUndefined(input);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = Reflect.get(value, "type");
  const workspaceId = Reflect.get(value, "workspaceId");
  const conversationId = Reflect.get(value, "conversationId");
  const messageId = Reflect.get(value, "messageId");
  const sequence = Reflect.get(value, "sequence");
  const kind = Reflect.get(value, "kind");
  const createdAt = Reflect.get(value, "createdAt");
  const preview = Reflect.get(value, "preview");
  const sender = Reflect.get(value, "sender");
  const senderUserId = Reflect.get(value, "senderUserId");
  const senderAgentId = Reflect.get(value, "senderAgentId");
  const threadRootId = Reflect.get(value, "threadRootId");
  if (
    type !== "conversation.activity.v1" ||
    typeof workspaceId !== "string" ||
    !workspaceId ||
    typeof conversationId !== "string" ||
    !conversationId ||
    typeof messageId !== "string" ||
    !messageId ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    (kind !== "channel" && kind !== "direct") ||
    typeof createdAt !== "string" ||
    !createdAt ||
    typeof preview !== "string" ||
    !isActivitySender(sender) ||
    (senderUserId !== undefined && (typeof senderUserId !== "string" || !senderUserId)) ||
    (senderAgentId !== undefined && (typeof senderAgentId !== "string" || !senderAgentId)) ||
    (threadRootId !== undefined && (typeof threadRootId !== "string" || !threadRootId))
  )
    return undefined;
  return {
    type,
    workspaceId,
    conversationId,
    messageId,
    sequence,
    kind,
    createdAt,
    preview,
    sender,
    ...(senderUserId ? { senderUserId } : {}),
    ...(senderAgentId ? { senderAgentId } : {}),
    ...(threadRootId ? { threadRootId } : {}),
  };
}

function isActivitySender(value: unknown): value is ConversationActivityEvent["sender"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = Reflect.get(value, "kind");
  const name = Reflect.get(value, "name");
  return (
    (kind === "user" || kind === "agent" || kind === "system") &&
    typeof name === "string" &&
    name.length > 0
  );
}
