import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { useEndReplyIntentsOnArrival } from "#src/features/agents/agent-post-clearing";
import { useConversationTasks } from "#src/features/tasks/use-conversation-tasks";
import {
  joinPublicChannel,
  markPublicChannelThreadRead,
  sendPublicChannelMessage,
  setPublicChannelThreadFollowed,
} from "./channels.functions";
import {
  directConversationQuery,
  directConversationUpdates,
  publicChannelQuery,
  publicChannelUpdates,
  useConversationQuery,
} from "./conversation-queries";
import { threadFollowingAgentsQueryPrefix } from "./conversation-query-keys";
import type { SendOptions } from "./composer-outbox";
import type { Reactor } from "./message-reactions";
import { useRefreshSidebarChannels } from "./sidebar-lists";
import {
  loadOwnConversationMessages,
  markDirectThreadRead,
  sendDirectConversationMessage,
} from "./conversations.functions";
import {
  toggleChannelMessageReactionVersioned,
  toggleDirectMessageReactionVersioned,
} from "./message-reactions.functions";
import type { DirectConversationView } from "./conversation-types";

const appRoute = getRouteApi("/w/$workspaceSlug");

/** The viewer as a reaction lists them: who they are and the name teammates see. `undefined` for a
 * non-member, whose chip waits for the server's summary. */
function useViewerReactor(viewerId: string | undefined): Reactor | undefined {
  const label = appRoute.useLoaderData({ select: ({ user }) => user.name });
  return viewerId ? { id: viewerId, label } : undefined;
}

/**
 * A channel as its page and the Tasks page's popup both show it: the loaded messages (kept live
 * by realtime), its Tasks, and what the viewer does there — send, react, join, read and follow
 * threads. `conversationProps` goes straight to `ChannelConversation`.
 */
export function useChannelConversation(channelId: string) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const send = useServerFn(sendPublicChannelMessage);
  const toggleReaction = useServerFn(toggleChannelMessageReactionVersioned);
  const join = useServerFn(joinPublicChannel);
  const markRead = useServerFn(markPublicChannelThreadRead);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const endReplyIntents = useEndReplyIntentsOnArrival();
  const page = useConversationQuery({
    onArrived: endReplyIntents,
    ...publicChannelQuery(channelId),
    loadUpdates: publicChannelUpdates(channelId),
    // No Task refresh here: a Task change arrives as its own `task.changed.v1` event, which
    // `useConversationTasks` writes into the conversation's Tasks. Reading Tasks again on every
    // publication meant one read per message in the conversation.
    onRealtime: () =>
      queryClient.invalidateQueries({
        queryKey: threadFollowingAgentsQueryPrefix(channelId),
      }),
  });
  const { conversation } = page;
  const viewerReactor = useViewerReactor(conversation.viewerId);
  const taskView = useConversationTasks(conversation.conversationId);

  // The settings panel writes the channel (name, description, archive), the viewer's own
  // membership (leave) or mute itself; this re-reads the page and the sidebar's channel list.
  const refreshSidebarChannels = useRefreshSidebarChannels();
  const refreshChannelAndSidebar = async () => {
    await Promise.all([page.invalidate(), refreshSidebarChannels()]);
  };

  return {
    page,
    taskView,
    refreshChannelAndSidebar,
    conversationProps: {
      conversation,
      canSendAsTask: true,
      onSend: async (
        body: string,
        idempotencyKey: string,
        attachmentIds?: string[],
        { threadRootId, mentions, asTask }: SendOptions = {},
      ) => {
        const message = await send({
          data: { channelId, idempotencyKey, body, attachmentIds, threadRootId, mentions, asTask },
        });
        page.mergeUpdates([message]);
        if (threadRootId) page.setThreadFollowed(threadRootId, true);
        void page.reconciliation.reconcile();
        return message;
      },
      onToggleReaction: (messageId: string, emoji: string, active: boolean) =>
        page.toggleReaction(messageId, emoji, viewerReactor, active, () =>
          toggleReaction({ data: { channelId, messageId, emoji, active } }),
        ),
      onJoin: async () => {
        await join({ data: { channelId } });
        // The layout's loader reuses the cached lists, so the channel list is re-read here.
        await Promise.all([
          page.invalidate(),
          refreshSidebarChannels(),
          router.invalidate({ sync: true }),
        ]);
      },
      onChanged: refreshChannelAndSidebar,
      onReadThread: async (threadRootId: string, throughSequence: number) => {
        await markRead({ data: { channelId, threadRootId, throughSequence } });
        page.applyThreadRead(threadRootId, throughSequence);
      },
      onThreadFollowedChange: async (threadRootId: string, followed: boolean) => {
        await setThreadFollowed({ data: { channelId, threadRootId, followed } });
        page.setThreadFollowed(threadRootId, followed);
      },
      onLoadOwnMessages: (beforeSequence?: number) =>
        loadOwnMessages({
          data: { conversationId: conversation.conversationId, beforeSequence },
        }),
      onLoadMessageAround: page.loadMessageAround,
      onShowLatest: page.showLatest,
      onFollowingLatestChange: page.setFollowingLatest,
      onLoadOlder: page.loadOlder,
      onLoadNewer: page.loadNewer,
    },
  };
}

/**
 * A direct conversation, by its id, as its page and the Tasks page's popup both show it: the
 * loaded messages (kept live by realtime), its Tasks, and what the viewer does there — send,
 * react, read threads. `conversationProps` goes straight to `DirectConversation`.
 */
export function useDirectConversation(conversationId: string) {
  const send = useServerFn(sendDirectConversationMessage);
  const toggleReaction = useServerFn(toggleDirectMessageReactionVersioned);
  const markRead = useServerFn(markDirectThreadRead);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const endReplyIntents = useEndReplyIntentsOnArrival();
  const page = useConversationQuery({
    onArrived: endReplyIntents,
    ...directConversationQuery(conversationId),
    loadUpdates: directConversationUpdates(conversationId),
    // No Task refresh here either — see the channel branch above.
  });
  const { conversation } = page;
  const viewerReactor = useViewerReactor(conversation.viewerId);
  const taskView = useConversationTasks(conversation.conversationId);

  return {
    page,
    conversation,
    taskView,
    conversationProps: {
      conversation: conversation as DirectConversationView,
      canSendAsTask: true,
      onSend: async (
        body: string,
        idempotencyKey: string,
        attachmentIds?: string[],
        // A direct conversation keeps `@handle` text as written, so the bindings of a send have
        // nothing to resolve there: only its thread and "As task" reach the server.
        { threadRootId, asTask }: SendOptions = {},
      ) => {
        const message = await send({
          data: { conversationId, idempotencyKey, body, attachmentIds, threadRootId, asTask },
        });
        page.mergeUpdates([message]);
        void page.reconciliation.reconcile();
        return message;
      },
      onToggleReaction: (messageId: string, emoji: string, active: boolean) =>
        page.toggleReaction(messageId, emoji, viewerReactor, active, () =>
          toggleReaction({ data: { conversationId, messageId, emoji, active } }),
        ),
      // The settings panel changed the viewer's preference for this DM: re-read the window.
      onChanged: page.invalidate,
      onReadThread: async (threadRootId: string, throughSequence: number) => {
        await markRead({ data: { conversationId, threadRootId, throughSequence } });
        page.applyThreadRead(threadRootId, throughSequence);
      },
      onLoadOwnMessages: (beforeSequence?: number) =>
        loadOwnMessages({ data: { conversationId, beforeSequence } }),
      onLoadMessageAround: page.loadMessageAround,
      onShowLatest: page.showLatest,
      onFollowingLatestChange: page.setFollowingLatest,
      onLoadOlder: page.loadOlder,
      onLoadNewer: page.loadNewer,
    },
  };
}
