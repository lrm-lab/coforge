import { Link } from "@tanstack/react-router";
import type { TaskStatus } from "@lrm/coforge-sdk/internal";

import { ChannelPlace } from "#src/features/conversations/channel-name";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { statusLabel, TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { SEARCH_HEADING_CLASS, SEARCH_ROW_CLASS } from "./search-entity-list";
import { SearchMatches } from "./search-matches";

type FoundTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  conversation: { id: string; channelName: string | null };
};

/** The Tasks found: where each lives and its number, its title, and its status. */
export function SearchTaskList({
  tasks,
  terms,
  onOpen,
}: {
  tasks: FoundTask[];
  terms: string[];
  onOpen: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <section aria-labelledby="search-tasks-heading" className="flex flex-col px-2 pt-2">
      <h2 id="search-tasks-heading" className={SEARCH_HEADING_CLASS}>
        {m.search_tasks()}
      </h2>
      <ul className="flex flex-col">
        {tasks.map((task) => {
          const { id, channelName } = task.conversation;
          const status = task.status as TaskStatus;
          return (
            <li key={task.id}>
              <Link
                {...conversationRoute(
                  channelName ? { channelId: id } : { dmId: id },
                  workspaceSlug,
                )}
                search={{ task: task.number }}
                data-search-option=""
                data-search-task={task.id}
                onClick={onOpen}
                className={SEARCH_ROW_CLASS}
              >
                <span className="flex max-w-[40%] min-w-0 shrink-0 items-center gap-1 text-xs text-tertiary tabular-nums">
                  {channelName ? (
                    <ChannelPlace id={id} name={channelName} />
                  ) : (
                    <span className="truncate">{m.search_task_direct()}</span>
                  )}
                  <span className="shrink-0">· #{task.number}</span>
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-primary">
                  <SearchMatches text={task.title} terms={terms} lead={Infinity} />
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-tertiary">
                  <TaskStatusIcon status={status} className="size-3.5" />
                  {statusLabel(status)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
