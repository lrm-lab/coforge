import { taskNameLabel, type TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Plus } from "@untitledui/icons";
import { useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { m } from "#src/paraglide/messages";
import { TaskHistory, type TimelineNames } from "./task-history";
import type { NamedActor } from "#src/features/avatars/actor-name";
import type { VisibleTaskName } from "./task-relation-edits";
import { TreeRow } from "./task-relations";
import { executeTask } from "./tasks.functions";
import { useTaskShow } from "./use-task-relations";

export function TaskSubtasks({
  task,
  canAdd,
  onAdd,
  onOpen,
}: {
  task: TaskView;
  canAdd: boolean;
  onAdd: () => void;
  onOpen?: (task: VisibleTaskName) => void;
}) {
  const { subtree } = useTaskShow(task);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const subtasks = task.subtasks;
  if (!subtasks) return null;
  return (
    <section aria-label={m.tasks_subtasks()} className="flex flex-col gap-1">
      <div className="flex h-8 items-center gap-2 text-sm">
        <h3 className="font-medium text-secondary">{m.tasks_subtasks()}</h3>
        <span className="text-tertiary tabular-nums">{m.tasks_subtasks_progress(subtasks)}</span>
        {canAdd && (
          <ButtonUtility
            icon={Plus}
            size="xs"
            color="tertiary"
            tooltip={m.tasks_add_subtask()}
            onClick={onAdd}
            className="ml-auto"
          />
        )}
      </div>
      <ul className="-mx-2">
        {subtree.map((node, index) => (
          <TreeRow
            key={node.hidden ? `hidden-${index}` : taskNameLabel(node)}
            node={node}
            depth={0}
            folded={folded}
            onToggle={(key) =>
              setFolded((current) => {
                const next = new Set(current);
                if (!next.delete(key)) next.add(key);
                return next;
              })
            }
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

type HistoryProps = {
  task: TaskView;
  onBack: () => void;
  /** The conversation's members, who name History's actors and assignees. */
  members?: readonly Mentionable[];
};

/** The Task's History, newest last; read when its page is first shown, not with the popup. */
export function TaskHistoryPage({ task, members, onBack }: HistoryProps) {
  const execute = useServerFn(executeTask);
  // Keyed by revision: every change bumps it, so the history reloads whenever the Task changes
  // and an older response can never overwrite a newer one.
  const history = useQuery({
    queryKey: ["task", "history", task.conversationId, task.number, task.revision],
    queryFn: async () => {
      const result = await execute({
        data: {
          operation: "history",
          idempotencyKey: crypto.randomUUID(),
          conversationId: task.conversationId,
          number: task.number,
        },
      });
      return result.history ?? [];
    },
    placeholderData: (previous) => previous,
  });

  // History names its actor by handle and an assignee by User/Agent id: the conversation's
  // members first, then the Task's own owner and creator, who may have left the conversation.
  const people: (NamedActor & { handle: string })[] = [
    ...(members ?? []).map(({ kind, id, handle, label, avatarUrl }) => ({
      kind,
      id,
      handle,
      name: label,
      avatarUrl,
    })),
    ...[task.owner, task.creator].filter((person) => person !== null),
  ];
  const unknown = m.tasks_history_unknown_member();
  const names: TimelineNames = {
    actor: (type, handle) => {
      const known = people.find((person) => person.kind === type && person.handle === handle);
      if (known) return known;
      // A person who has left the conversation is no longer listed, and their username is not a
      // name to read; an Agent's handle is its name. The system has no face.
      if (type === "system") return handle ?? unknown;
      return { kind: type, name: type === "user" ? unknown : (handle ?? unknown) };
    },
    assignee: (kind, id) =>
      people.find((person) => person.kind === kind && person.id === id) ?? {
        kind,
        id,
        name: unknown,
      },
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-2 pt-3 sm:px-6">
        <Button color="link-gray" size="sm" iconLeading={ArrowLeft} onPress={onBack}>
          {m.tasks_back()}
        </Button>
      </div>
      <div className="px-4 py-4 sm:px-6">
        <TaskHistory
          loading={history.isPending}
          failed={history.isError}
          retrying={history.isRefetching}
          onRetry={() => void history.refetch()}
          events={history.data}
          names={names}
        />
      </div>
    </div>
  );
}
