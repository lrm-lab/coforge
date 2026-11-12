import type { TaskProjectRef, TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { joinPublicChannel } from "#src/features/conversations/channels.functions";
import { openDirectConversation } from "#src/features/conversations/conversations.functions";
import type { ForwardTarget } from "#src/features/conversations/message-forward";
import { BoardAssignTo, useAssignTargets } from "./board-assign-to";
import { CreateTaskDialog } from "./create-task-dialog";
import { executeTask } from "./tasks.functions";

/** A channel a new Task can go in. */
export type NewTaskPlace = { conversationId: string; label: string };

/** The columns a new Task can start in; Closed is for work that was dropped. */
const STATUSES = ["todo", "in_progress", "in_review", "done"] as const satisfies TaskStatus[];
export const canCreateIn = (status: TaskStatus) =>
  (STATUSES as readonly TaskStatus[]).includes(status);

/** Who has a Task assigned to `target`; a channel's has no owner yet. */
function assignee(target: ForwardTarget) {
  if (target.kind === "person") return `user:${target.userId}`;
  return target.kind === "agent" ? `agent:${target.agentId}` : undefined;
}

/**
 * "New task" on the board (task #596): the create dialog, with the control that picks where it goes
 * (Frank, 11-06: a channel, or a person or an Agent, whose Task goes in the viewer's DM with them)
 * and its column. It starts at the channel the board's Tasks were last filed in.
 */
export function BoardNewTaskDialog({
  open,
  status,
  places,
  boardProject,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  /** The column it was opened from. */
  status: TaskStatus;
  places: readonly NewTaskPlace[];
  /** The Project of the board it was opened on. */
  boardProject?: TaskProjectRef;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const execute = useServerFn(executeTask);
  const join = useServerFn(joinPublicChannel);
  const openDirect = useServerFn(openDirectConversation);
  const reach = useAssignTargets();
  /** Whom the viewer picked, until which it is the channel the board last filed in. */
  const [picked, setPicked] = useState<ForwardTarget>();
  const [column, setColumn] = useState<TaskStatus>(status);
  useEffect(() => {
    if (open) setColumn(status);
  }, [open, status]);
  const assignTo = picked ?? defaultTarget(places, reach.targets);
  // A person or an Agent with no DM yet has no conversation to read a last-used Project from.
  const conversationId = assignTo?.conversationId ?? undefined;

  /** Where a Task for `target` goes: a channel, joined if need be, or the DM with them, opened on
   * first use. */
  async function conversationOf(target: ForwardTarget) {
    if (target.kind === "channel") {
      if (!target.joined) await join({ data: { channelId: target.conversationId } });
      return target.conversationId;
    }
    if (target.conversationId) return target.conversationId;
    const { conversationId: opened } = await openDirect({
      data: target.kind === "person" ? { userId: target.userId } : { agentId: target.agentId },
    });
    return opened;
  }

  return (
    <CreateTaskDialog
      open={open}
      onOpenChange={onOpenChange}
      conversationId={conversationId}
      board={{
        place: (
          <BoardAssignTo
            value={assignTo}
            targets={reach.targets}
            onSearch={reach.setQuery}
            disabled={false}
            onChange={setPicked}
          />
        ),
        status: column,
        statuses: STATUSES,
        onStatusChange: setColumn,
        project: boardProject,
      }}
      onCreate={async (draft, idempotencyKey, { more }) => {
        if (!assignTo) throw new Error("no place");
        await execute({
          data: {
            operation: "create",
            idempotencyKey,
            conversationId: await conversationOf(assignTo),
            title: draft.title,
            ...(draft.description && { description: draft.description }),
            project: draft.project ?? null,
            priority: draft.priority,
            ...(draft.labels && { labels: draft.labels }),
            ...(assignee(assignTo) && { assignee: assignee(assignTo) }),
            ...(column !== "todo" && { status: column }),
          },
        });
        // The next one, while the viewer keeps creating, goes to the same place.
        if (!more) setPicked(undefined);
        onCreated();
      }}
    />
  );
}

/** The board's newest channel the viewer can still post in; an archived one cannot (task #621). A
 * board that holds no Task yet has learned no channel its Tasks were filed in (task #60), so the
 * viewer's own channels stand in, the server's order putting the joined ones first. */
export function defaultTarget(
  places: readonly NewTaskPlace[],
  targets: readonly ForwardTarget[],
): ForwardTarget | undefined {
  for (const place of places) {
    const known = targets.find(
      (target) => target.kind === "channel" && target.conversationId === place.conversationId,
    );
    if (known) {
      if (known.canSend) return known;
      continue;
    }
    return {
      kind: "channel",
      conversationId: place.conversationId,
      name: place.label.replace(/^#/, ""),
      visibility: "public",
      // The picker reads its group avatar from the sidebar until the search lists it.
      members: [],
      joined: true,
      canSend: true,
    };
  }
  return targets.find((target) => target.kind === "channel" && target.canSend);
}

/** Whether the board can file a new Task at all: a channel its own Tasks were filed in, or, before
 * it holds one, a channel the viewer can post in (task #60). A board that offers neither has
 * nowhere to put a Task, and says so by not offering the control. */
export const canFileNewTask = (
  places: readonly NewTaskPlace[],
  targets: readonly ForwardTarget[],
) => places.length > 0 || targets.some((target) => target.kind === "channel" && target.canSend);

/**
 * What the dialog offers on a board, read from the Tasks the board shows: their channels, the one
 * most recently filed in first (a direct conversation is no channel to file in), the people who
 * hold them and, on a Project's board, that Project.
 */
export function newTaskChoices(
  tasks: readonly {
    conversationId: string;
    createdAt: string;
    source?: { label: string; channelName?: string | null };
    owner?: TaskView["owner"];
    project?: TaskView["project"];
  }[],
  projectSlug?: string,
) {
  const byConversation = new Map<string, NewTaskPlace & { at: string }>();
  for (const task of tasks) {
    // A direct message has no channelName; its Tasks do not make it a place.
    if (!task.source?.channelName) continue;
    const known = byConversation.get(task.conversationId);
    if (!known || known.at < task.createdAt)
      byConversation.set(task.conversationId, {
        conversationId: task.conversationId,
        label: task.source.label,
        at: task.createdAt,
      });
  }
  return {
    places: [...byConversation.values()].sort((a, b) => b.at.localeCompare(a.at)),
    boardProject: projectSlug
      ? (tasks.find((task) => task.project?.slug === projectSlug)?.project ?? undefined)
      : undefined,
  };
}
