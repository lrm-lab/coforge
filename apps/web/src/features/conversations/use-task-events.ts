import { useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { loadTaskConversationEvents } from "#src/features/tasks/task-conversation.functions";
import { withTaskEvents, type TaskEventPeople } from "#src/features/tasks/task-timeline-rows";
import { m } from "#src/paraglide/messages";
import type { Mentionable } from "./mention-text";
import type { MessageView } from "./message-view";

export function useTaskEvents<M extends MessageView & { system?: { kind: string } }>({
  conversationId,
  messages,
  loaded,
  number,
  changedAt,
  members,
}: {
  conversationId: string | undefined;
  messages: readonly M[];
  loaded: boolean;
  number: number;
  changedAt: string | undefined;
  members: readonly Mentionable[] | undefined;
}) {
  const load = useServerFn(loadTaskConversationEvents);
  const oldest = messages[0]?.sequence;
  const events = useQuery({
    queryKey: ["conversation", "task-events", conversationId, oldest, changedAt] as const,
    queryFn: () =>
      load({
        data: { conversationId: conversationId!, ...(oldest ? { oldestSequence: oldest } : {}) },
      }),
    enabled: conversationId !== undefined && loaded,
    placeholderData: keepPreviousData,
  });
  const people = useMemo<TaskEventPeople>(() => {
    const unknown = m.system_notice_actor_unknown();
    const person = (found: Mentionable | undefined, handle: string | null) => ({
      memberId: null,
      handle: found?.handle ?? handle ?? "",
      displayName: found?.label ?? handle ?? unknown,
    });
    return {
      actor: (type, handle) =>
        person(
          members?.find((member) => member.kind === type && member.handle === handle),
          type === "user" ? null : handle,
        ),
      assignee: (kind, id) =>
        person(
          members?.find((member) => member.kind === kind && member.id === id),
          null,
        ),
    };
  }, [members]);
  const settled = useRef<ReturnType<typeof withTaskEvents<M>>>(undefined);
  const timeline = useMemo(
    () =>
      events.isPlaceholderData
        ? undefined
        : withTaskEvents(messages, events.data ?? [], { number }, people),
    [messages, events.data, events.isPlaceholderData, number, people],
  );
  if (timeline) settled.current = timeline;
  return timeline ?? settled.current ?? [...messages];
}
