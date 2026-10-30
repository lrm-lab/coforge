import { FORWARD_DESTINATIONS_MAX } from "./message-forward";
import type {
  ForwardFailureCode,
  ForwardMessageResult,
  ForwardTarget,
  ForwardedMessageView,
} from "./message-forward";
import type { MessageView } from "./message-view";

/** The message a forward dialog is opened for, and where it sits (`name` is null in a DM). */
export type ForwardSource = {
  message: MessageView;
  conversationId: string;
  conversationName: string | null;
};

/**
 * Whether a message offers "Forward": a person's or an Agent's own words. A forward, an action
 * card and a server notice stay where they are (the server refuses them too,
 * `forward-not-forwardable`).
 */
export function canForwardMessage(
  message: Pick<MessageView, "senderKind" | "actionCard" | "forwarded">,
): boolean {
  return message.senderKind !== "system" && !message.actionCard && !message.forwarded;
}

/** The snapshot the dialog previews: what the server will freeze, read from the row on screen. */
export function forwardedPreview(source: ForwardSource, plainBody: string): ForwardedMessageView {
  const { message } = source;
  return {
    sourceSenderHandle: message.senderHandle ?? message.senderName,
    sourceCreatedAt: new Date(message.createdAt).toISOString(),
    sourceBody: plainBody,
    sourceConversation: {
      id: source.conversationId,
      name: source.conversationName,
    },
    ...(message.threadRootId ? { sourceThreadRootId: message.threadRootId } : {}),
    sourceAccessible: false,
  };
}

/** One key per target across searches: a channel by its conversation, a person or an Agent by
 * who they are (their DM may not exist yet). */
export function forwardTargetKey(target: ForwardTarget): string {
  if (target.kind === "channel") return `channel:${target.conversationId}`;
  return target.kind === "person" ? `person:${target.userId}` : `agent:${target.agentId}`;
}

/** How a target reads in the picker and in a toast: `#channel`, or `@Name` for a person or Agent. */
export function forwardTargetLabel(target: ForwardTarget): string {
  return target.kind === "channel" ? `#${target.name}` : `@${target.name}`;
}

/** A public channel the viewer is not in: the forward joins it first, after one confirmation. */
export function isUnjoinedChannel(target: ForwardTarget): boolean {
  return target.kind === "channel" && !target.joined;
}

/** Whether `target` can be ticked now: not a disabled one, and room is left in the selection. */
export function canSelectTarget(target: ForwardTarget, selectedCount: number, selected: boolean) {
  return target.canSend && (selected || selectedCount < FORWARD_DESTINATIONS_MAX);
}

/** Where "Open source message" navigates: a conversation route with the original's row in `search`. */
export type ForwardSourceTarget =
  | {
      to: "/w/$workspaceSlug/channel/$channelId";
      params: { workspaceSlug: string; channelId: string };
      search: { message: string; threadRootId?: string };
    }
  | {
      to: "/w/$workspaceSlug/dm/$dmId";
      params: { workspaceSlug: string; dmId: string };
      search: { message: string; threadRootId?: string };
    };

/** Where "Open source message" goes: the original's conversation at its row in the stream, with
 * its thread open when it was a reply. A forward only offers it while `sourceAccessible`. */
export function forwardSourceTarget(
  workspaceSlug: string,
  forwarded: ForwardedMessageView,
): ForwardSourceTarget | undefined {
  if (!forwarded.sourceMessageId) return undefined;
  const { id, name } = forwarded.sourceConversation;
  const anchor = forwarded.sourceThreadRootId ?? forwarded.sourceMessageId;
  const search = {
    message: anchor,
    ...(forwarded.sourceThreadRootId ? { threadRootId: forwarded.sourceThreadRootId } : {}),
  };
  return name !== null
    ? {
        to: "/w/$workspaceSlug/channel/$channelId",
        params: { workspaceSlug, channelId: id },
        search,
      }
    : { to: "/w/$workspaceSlug/dm/$dmId", params: { workspaceSlug, dmId: id }, search };
}

/** What a send's result leaves for the dialog to show. */
export type ForwardOutcomeView =
  | { kind: "done"; destinations: string[] }
  | { kind: "partial"; delivered: number; total: number; failed: Map<string, ForwardFailureCode> }
  | { kind: "none"; total: number; failed: Map<string, ForwardFailureCode> };

/** A forward's result by what the dialog does next: close, or keep the failed rows to retry. */
export function forwardOutcomeView(result: ForwardMessageResult): ForwardOutcomeView {
  const failed = new Map<string, ForwardFailureCode>();
  for (const entry of result.results) {
    if (entry.status === "failed") failed.set(entry.destination, entry.error.code);
  }
  const total = result.results.length;
  if (failed.size === 0) {
    return { kind: "done", destinations: result.results.map((entry) => entry.destination) };
  }
  return failed.size === total
    ? { kind: "none", total, failed }
    : { kind: "partial", delivered: total - failed.size, total, failed };
}

/** Whether another attempt may reach a destination that refused: a send that failed, or a channel
 * the forwarder had not joined yet (the dialog joins it first). */
export function isRetryableForwardFailure(code: ForwardFailureCode): boolean {
  return code === "failed" || code === "not_joined";
}
