import { useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";

import {
  markPublicChannelRead,
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
  setPublicConversationUnread,
} from "#src/features/conversations/channels.functions";
import {
  markDirectConversationRead,
  markDirectThreadRead,
  setDirectConversationUnread,
} from "#src/features/conversations/conversations.functions";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { markActivityItemDone, setActivityMentionRead } from "./activity-inbox.functions";
import {
  cancelActivityInboxListReads,
  type ActivityCompletionItem,
} from "./activity-inbox-queries";

export type ActivityItemActions = ReturnType<typeof useActivityItemActions>;

/**
 * What a row can do. Reading, marking unread and following reuse the conversation's own
 * functions, so the Chat sidebar and the inbox move the same cursors. Done hides the row at once
 * and the refetch puts it back if the server refused. The returned object is stable, so rows
 * re-render only when their own item changes.
 */
export function useActivityItemActions({
  workspaceId,
  onChanged,
  onFailure,
  onDoneStarted,
  onDoneSettled,
}: {
  workspaceId: string;
  onChanged: () => Promise<void>;
  onFailure: (failure: { retry: () => void } | null) => void;
  onDoneStarted: (item: ActivityCompletionItem) => void;
  onDoneSettled: (item: ActivityCompletionItem) => void;
}) {
  const queryClient = useQueryClient();
  const markChannelRead = useServerFn(markPublicChannelRead);
  const markChannelThreadRead = useServerFn(markPublicChannelThreadRead);
  const markDirectRead = useServerFn(markDirectConversationRead);
  const markDirectThread = useServerFn(markDirectThreadRead);
  const setChannelUnread = useServerFn(setPublicConversationUnread);
  const setDirectUnread = useServerFn(setDirectConversationUnread);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const markDone = useServerFn(markActivityItemDone);
  const setMentionRead = useServerFn(setActivityMentionRead);

  return useMemo(() => {
    function run(
      action: () => Promise<unknown>,
      lifecycle?: { start: () => void; settle: () => void },
    ) {
      onFailure(null);
      lifecycle?.start();
      // Through a resolved promise, so a synchronous throw is reported like a rejection.
      void Promise.resolve()
        .then(action)
        .catch(() => onFailure({ retry: () => run(action, lifecycle) }))
        .finally(async () => {
          try {
            await onChanged();
          } finally {
            lifecycle?.settle();
          }
        });
    }

    function read({
      place,
      thread,
      latestSequence: throughSequence,
      mentionAction,
    }: ActivityInboxItem) {
      // A mention the viewer was notified of keeps its own read state: they are not in the channel.
      if (mentionAction)
        return setMentionRead({ data: { resolutionId: mentionAction.resolutionId, read: true } });
      if (thread) {
        const threadRootId = thread.root.id;
        return place.kind === "channel"
          ? markChannelThreadRead({
              data: { channelId: place.conversationId, threadRootId, throughSequence },
            })
          : markDirectThread({
              data: { conversationId: place.conversationId, threadRootId, throughSequence },
            });
      }
      return place.kind === "channel"
        ? markChannelRead({ data: { channelId: place.conversationId, throughSequence } })
        : markDirectRead({ data: { conversationId: place.conversationId, throughSequence } });
    }

    return {
      read: (item: ActivityInboxItem) => run(() => read(item)),
      // Saved directly: the sidebar's optimistic lists are synced only on the Chat page, and the
      // refresh afterwards brings the sidebar's badge along.
      unread: ({ place, mentionAction }: ActivityInboxItem) =>
        run(() =>
          mentionAction
            ? setMentionRead({ data: { resolutionId: mentionAction.resolutionId, read: false } })
            : place.kind === "channel"
              ? setChannelUnread({ data: { channelId: place.conversationId, unread: true } })
              : setDirectUnread({ data: { conversationId: place.conversationId, unread: true } }),
        ),
      unfollow: ({ place, thread }: ActivityInboxItem) => {
        if (!thread) return;
        run(() =>
          setThreadFollowed({
            data: {
              channelId: place.conversationId,
              threadRootId: thread.root.id,
              followed: false,
            },
          }),
        );
      },
      done: (item: ActivityInboxItem) =>
        run(
          async () => {
            await cancelActivityInboxListReads(queryClient, workspaceId);
            await markDone({
              data: item.mentionAction
                ? { kind: "mention_action", resolutionId: item.mentionAction.resolutionId }
                : item.thread
                  ? {
                      kind: "thread",
                      conversationId: item.place.conversationId,
                      rootMessageId: item.thread.root.id,
                      throughSequence: item.latestSequence,
                    }
                  : {
                      kind: "conversation",
                      conversationId: item.place.conversationId,
                      throughSequence: item.latestSequence,
                    },
            });
          },
          { start: () => onDoneStarted(item), settle: () => onDoneSettled(item) },
        ),
    };
  }, [
    queryClient,
    workspaceId,
    onChanged,
    onFailure,
    onDoneStarted,
    onDoneSettled,
    markChannelRead,
    markChannelThreadRead,
    markDirectRead,
    markDirectThread,
    setChannelUnread,
    setDirectUnread,
    setThreadFollowed,
    markDone,
    setMentionRead,
  ]);
}
