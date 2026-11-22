import { Link } from "@tanstack/react-router";
import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { AnimatePresence, motion } from "motion/react";

import { ChannelPlace } from "#src/features/conversations/channel-name";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { statusLabel, TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { DURATION_S, EASE_IN, EASE_IN_OUT, EASE_OUT } from "#src/utils/motion-tokens";
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
  const reduced = usePrefersReducedMotion();
  return (
    <section aria-labelledby="search-tasks-heading" className="flex flex-col px-2 pt-2">
      <h2 id="search-tasks-heading" className={SEARCH_HEADING_CLASS}>
        {m.search_tasks()}
      </h2>
      <ul className="relative flex flex-col">
        <AnimatePresence initial={false} mode="popLayout">
          {tasks.map((task) => {
            const { id, channelName } = task.conversation;
            const status = task.status as TaskStatus;
            return (
              <motion.li
                key={task.id}
                layout={reduced ? false : "position"}
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{
                  opacity: 0,
                  transition: { duration: DURATION_S.smOut, ease: EASE_IN },
                }}
                transition={{
                  duration: reduced ? DURATION_S.reduced : DURATION_S.sm,
                  ease: EASE_OUT,
                  layout: { duration: DURATION_S.sm, ease: EASE_IN_OUT },
                }}
              >
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
                  <span className="flex max-w-[40%] min-w-0 shrink-0 items-center gap-1.5 text-xs text-tertiary tabular-nums">
                    {channelName ? (
                      <ChannelPlace id={id} name={channelName} />
                    ) : (
                      <span className="truncate">{m.search_task_direct()}</span>
                    )}
                    <span className="shrink-0 text-quaternary">#{task.number}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-primary">
                    <SearchMatches text={task.title} terms={terms} lead={Infinity} />
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-tertiary">
                    <TaskStatusIcon status={status} className="size-3.5" />
                    {statusLabel(status)}
                  </span>
                </Link>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
