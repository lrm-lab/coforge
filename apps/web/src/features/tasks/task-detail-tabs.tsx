import { taskNameLabel, type TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ClockRewind, Dataflow02, MessageChatCircle, Plus } from "@untitledui/icons";
import type { FC, ReactNode } from "react";
import { useState } from "react";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { TaskHistory, type TimelineNames } from "./task-history";
import type { VisibleTaskName } from "./task-relation-edits";
import { TreeRow } from "./task-relations";
import { executeTask } from "./tasks.functions";
import { useTaskShow } from "./use-task-relations";

/**
 * The Task popup's body under its properties, one page at a time: the discussion, the sub-tasks
 * and History. A long sub-task tree or a long History gets the popup's whole height and scrolls
 * like the discussion does, rather than squeezing into a popover.
 */
export type TaskDetailTab = "discussion" | "subtasks" | "history";

/** The sub-tasks' icon is the one the ⋯ menu adds them with. */
const TAB_ICON: Record<TaskDetailTab, FC<{ className?: string }>> = {
  discussion: MessageChatCircle,
  subtasks: Dataflow02,
  history: ClockRewind,
};

/**
 * The Task above its tabs, then the selected tab's page. The Task and the tab strip stay mounted
 * across switches, so focus stays on the tab strip and a change still saving keeps its state.
 */
export function TaskDetailTabs({
  tabs,
  selected,
  onChange,
  subtasks,
  task,
  sidebar,
  pages,
}: {
  tabs: readonly TaskDetailTab[];
  selected: TaskDetailTab;
  onChange: (tab: TaskDetailTab) => void;
  subtasks: TaskView["subtasks"];
  /** The Task's title and properties, above the tab strip. */
  task: ReactNode;
  /** The properties, as a column beside the pages on a wide screen (Linear's issue). */
  sidebar?: ReactNode;
  /** Each tab's page. The discussion fills its panel and scrolls itself; the others scroll here. */
  pages: Record<TaskDetailTab, () => ReactNode>;
}) {
  const label: Record<TaskDetailTab, string> = {
    discussion: m.tasks_tab_discussion(),
    subtasks: subtasks
      ? `${m.tasks_subtasks()} ${m.tasks_subtasks_progress(subtasks)}`
      : m.tasks_subtasks(),
    history: m.tasks_history(),
  };
  return (
    <div className="flex min-h-0 flex-1">
      <Tabs
        selectedKey={selected}
        onSelectionChange={(key) => onChange(key as TaskDetailTab)}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 flex-col gap-3 border-b border-secondary">
          {task}
          <TabList
            type="underline"
            size="sm"
            aria-label={m.tasks_tabs_label()}
            className="-mb-px px-4 sm:px-6"
          >
            {tabs.map((tab) => (
              <Tab key={tab} id={tab} icon={TAB_ICON[tab]}>
                {label[tab]}
              </Tab>
            ))}
          </TabList>
        </div>
        {tabs.map((tab) => (
          <TabPanel
            key={tab}
            id={tab}
            className={cn(
              "min-h-0 flex-1 outline-hidden",
              tab === "discussion"
                ? "flex h-[min(60vh,40rem)] flex-col max-sm:h-auto"
                : "overflow-y-auto",
            )}
          >
            {pages[tab]()}
          </TabPanel>
        ))}
      </Tabs>
      {sidebar && (
        <aside className="w-64 shrink-0 overflow-y-auto border-l border-secondary px-4 py-3">
          {sidebar}
        </aside>
      )}
    </div>
  );
}

/** The whole sub-task tree, folded per Task, with a button under it that adds another. */
export function TaskSubtasksPage({
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
  const { subtree } = useTaskShow(task, true);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="flex flex-col gap-2 px-2.5 py-3 sm:px-4.5">
      <ul>
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
      {canAdd && (
        <div className="px-1.5">
          <Button color="link-gray" size="sm" iconLeading={Plus} onClick={onAdd}>
            {m.tasks_add_subtask()}
          </Button>
        </div>
      )}
    </div>
  );
}

type HistoryProps = {
  task: TaskView;
  /** The conversation's members, who name History's actors and assignees. */
  members?: readonly Mentionable[];
};

/** The Task's History, newest last; read when its page is first shown, not with the popup. */
export function TaskHistoryPage({ task, members }: HistoryProps) {
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
  const people = [
    ...(members ?? []).map(({ kind, id, handle, label }) => ({ kind, id, handle, name: label })),
    ...[task.owner, task.creator].filter((person) => person !== null),
  ];
  const unknown = m.tasks_history_unknown_member();
  const names: TimelineNames = {
    actor: (type, handle) => {
      const known = people.find((person) => person.kind === type && person.handle === handle);
      if (known) return known.name;
      // A person who has left the conversation is no longer listed, and their username is not a
      // name to read; an Agent's handle is its name.
      return type === "user" ? unknown : (handle ?? unknown);
    },
    assignee: (kind, id) =>
      people.find((person) => person.kind === kind && person.id === id)?.name ?? unknown,
  };

  return (
    <div className="px-4 py-4 sm:px-6">
      <TaskHistory failed={history.isError} events={history.data} names={names} />
    </div>
  );
}
