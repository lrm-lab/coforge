import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell01 as Bell, BellOff01 as BellOff } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ACTIVITY_INBOX_QUERY_PREFIX } from "#src/features/inbox/activity-inbox-queries";
import { m } from "#src/paraglide/messages";
import { getTaskFollow, setTaskFollow } from "./task-conversation.functions";

type TaskRef = { conversationId: string; number: number };

export const taskFollowQueryKey = ({ conversationId, number }: TaskRef) =>
  ["task", "follow", conversationId, number] as const;

/** Whether a Task has a conversation of its own — one made without a message, or one already
 * spoken in — rather than its message's thread. */
export function ownsDiscussion(task: Pick<TaskView, "discussionConversationId" | "messageId">) {
  return Boolean(task.discussionConversationId || !task.messageId);
}

/** Whether the viewer follows the Task, and how to change it; absent while unknown. */
export function useTaskFollow(task: TaskRef, enabled: boolean) {
  const ref = { conversationId: task.conversationId, number: task.number };
  const key = taskFollowQueryKey(ref);
  const read = useServerFn(getTaskFollow);
  const write = useServerFn(setTaskFollow);
  const queryClient = useQueryClient();
  const followed = useQuery({
    queryKey: key,
    queryFn: () => read({ data: ref }),
    enabled,
  }).data?.following;
  const change = useMutation({
    mutationFn: (follow: boolean) => write({ data: { ...ref, follow } }),
    onMutate: async (follow) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, { following: follow });
    },
    // Activity lists the Tasks the viewer follows.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX }),
      ]),
  });
  return followed === undefined
    ? undefined
    : { followed, onChange: (follow: boolean) => change.mutate(follow) };
}

/** The Task menu's follow item, as a thread's menu has one. */
export function taskFollowMenuItem(follow: NonNullable<ReturnType<typeof useTaskFollow>>) {
  return (
    <Dropdown.Item
      id="follow"
      icon={follow.followed ? BellOff : Bell}
      label={follow.followed ? m.tasks_unfollow() : m.tasks_follow()}
      onAction={() => follow.onChange(!follow.followed)}
    />
  );
}
