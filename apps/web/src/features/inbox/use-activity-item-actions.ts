import { useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";

import { markPublicChannelRead } from "#src/features/conversations/channels.functions";
import { setPublicConversationUnread } from "#src/features/conversations/channel-sidebar-actions.functions";
import {
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
} from "#src/features/conversations/channel-threads.functions";
import {
  markDirectConversationRead,
  markDirectThreadRead,
  setDirectConversationUnread,
} from "#src/features/conversations/conversations.functions";
import { markOpenReadStale } from "#src/features/conversations/conversation-open-query";
import { applyThreadUnreadChangeToConversationCaches } from "#src/features/conversations/thread-cache";
import { markConversationThreadUnread } from "#src/features/conversations/thread-unread.functions";
import {
  markTaskConversationRead,
  setTaskFollow,
} from "#src/features/tasks/task-conversation.functions";
import { doneTarget } from "./activity-item-kind";
import { taskFollowQueryKey } from "#src/features/tasks/task-follow";
import type {
  ActivityConversationItem,
  ActivityInboxItem,
} from "#src/server/inbox/activity-inbox.server";
import {
  markActivityItemDone,
  markActivityItemRead,
  setActivityMentionRead,
} from "./activity-inbox.functions";
import {
  cancelActivityInboxListReads,
  type ActivityCompletionItem,
} from "./activity-inbox-queries";

export type ActivityItemActions = ReturnType<typeof useActivityItemActions>;

export function useActivityItemActions({
  workspaceId,
  onChanged,
  onFailure,
  enqueueDone,
}: {
  workspaceId: string;
  onChanged: () => Promise<void>;
  onFailure: (failure: { retry: () => void } | null) => void;
  enqueueDone: (
    item: ActivityCompletionItem,
    write: () => Promise<unknown>,
    onFailed: () => void,
  ) => void;
}) {
  const queryClient = useQueryClient();
  const markChannelRead = useServerFn(markPublicChannelRead);
  const markChannelThreadRead = useServerFn(markPublicChannelThreadRead);
  const markDirectRead = useServerFn(markDirectConversationRead);
  const markDirectThread = useServerFn(markDirectThreadRead);
  const setChannelUnread = useServerFn(setPublicConversationUnread);
  const setDirectUnread = useServerFn(setDirectConversationUnread);
  const markThreadUnread = useServerFn(markConversationThreadUnread);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const markTaskRead = useServerFn(markTaskConversationRead);
  const setTaskFollowed = useServerFn(setTaskFollow);
  const markDone = useServerFn(markActivityItemDone);
  const markItemRead = useServerFn(markActivityItemRead);
  const setMentionRead = useServerFn(setActivityMentionRead);

  return useMemo(() => {
    function run(action: () => Promise<unknown>) {
      onFailure(null);
      void Promise.resolve()
        .then(action)
        .catch(() => onFailure({ retry: () => run(action) }))
        .finally(() => void onChanged());
    }

    function read({
      place,
      thread,
      task,
      latestSequence: throughSequence,
      mentionAction,
      markedUnreadVersion,
    }: ActivityConversationItem) {
      if (mentionAction)
        return setMentionRead({ data: { resolutionId: mentionAction.resolutionId, read: true } });
      if (task)
        return markTaskRead({
          data: { conversationId: place.conversationId, number: task.number, throughSequence },
        });
      if (thread) {
        const read = {
          threadRootId: thread.root.id,
          throughSequence,
          ...(markedUnreadVersion && { markedUnreadVersion }),
        };
        return (
          place.kind === "channel"
            ? markChannelThreadRead({
                data: { channelId: place.conversationId, ...read },
              })
            : markDirectThread({
                data: { conversationId: place.conversationId, ...read },
              })
        ).then(() => {
          markOpenReadStale(queryClient, place.conversationId, thread.root.id);
          if (markedUnreadVersion) {
            applyThreadUnreadChangeToConversationCaches(queryClient, {
              conversationId: place.conversationId,
              rootMessageId: thread.root.id,
              version: markedUnreadVersion,
              action: "cleared",
            });
          }
        });
      }
      return place.kind === "channel"
        ? markChannelRead({ data: { channelId: place.conversationId, throughSequence } })
        : markDirectRead({ data: { conversationId: place.conversationId, throughSequence } });
    }

    function done(item: ActivityInboxItem) {
      onFailure(null);
      enqueueDone(
        item,
        async () => {
          await cancelActivityInboxListReads(queryClient, workspaceId);
          await markDone({
            data: doneTarget(item),
          });
          if (item.kind === "conversation" && item.thread) {
            markOpenReadStale(queryClient, item.place.conversationId, item.thread.root.id);
            if (item.markedUnreadVersion) {
              applyThreadUnreadChangeToConversationCaches(queryClient, {
                conversationId: item.place.conversationId,
                rootMessageId: item.thread.root.id,
                version: item.markedUnreadVersion,
                action: "cleared",
              });
            }
          }
        },
        () => onFailure({ retry: () => done(item) }),
      );
    }

    return {
      read: (item: ActivityInboxItem) =>
        run(() =>
          item.kind === "artifact"
            ? markItemRead({
                data: {
                  kind: "artifact",
                  artifactId: item.artifact.id,
                  throughAt: new Date(item.at).getTime(),
                },
              })
            : read(item),
        ),
      unread: (item: ActivityConversationItem) => {
        const { place, mentionAction, thread } = item;
        return run(async () => {
          if (mentionAction)
            return setMentionRead({
              data: { resolutionId: mentionAction.resolutionId, read: false },
            });
          if (thread && !thread.task) {
            const mark = await markThreadUnread({
              data: { conversationId: place.conversationId, rootMessageId: thread.root.id },
            });
            applyThreadUnreadChangeToConversationCaches(queryClient, {
              conversationId: place.conversationId,
              rootMessageId: mark.rootMessageId,
              version: mark.version,
              action: "marked",
            });
            markOpenReadStale(queryClient, place.conversationId, mark.rootMessageId);
            return;
          }
          if (place.kind === "channel")
            return setChannelUnread({ data: { channelId: place.conversationId, unread: true } });
          return setDirectUnread({ data: { conversationId: place.conversationId, unread: true } });
        });
      },
      unfollow: ({ place, thread, task }: ActivityConversationItem) => {
        if (task) {
          const ref = { conversationId: place.conversationId, number: task.number };
          return run(async () => {
            await setTaskFollowed({ data: { ...ref, follow: false } });
            await queryClient.invalidateQueries({ queryKey: taskFollowQueryKey(ref) });
          });
        }
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
      done,
    };
  }, [
    queryClient,
    workspaceId,
    onChanged,
    onFailure,
    enqueueDone,
    markChannelRead,
    markChannelThreadRead,
    markDirectRead,
    markDirectThread,
    setChannelUnread,
    setDirectUnread,
    markThreadUnread,
    setThreadFollowed,
    markTaskRead,
    setTaskFollowed,
    markDone,
    markItemRead,
    setMentionRead,
  ]);
}
