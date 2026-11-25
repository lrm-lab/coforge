import type { ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";

import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import type { TaskDetailNavigation } from "#src/features/tasks/task-detail-panel";
import type { useEdgeSwipeBack } from "#src/hooks/use-edge-swipe-back";
import { DURATION_S, EASE_IN, EASE_OUT } from "#src/utils/motion-tokens";
import { ActivityConversationPane, type ActivityPaneFlow } from "./activity-conversation-pane";
import { ActivityInboxIdlePane } from "./activity-inbox-states";
import { ActivityTaskPopup } from "./activity-task-popup";

type TaskTarget = HostedConversationTarget & { task: number };

export function ActivityInboxDetailPane({
  desktop,
  pane,
  inlineTask,
  phoneTask,
  isTaskExpanded,
  onToggleTaskExpand,
  taskNavigation,
  paneFlow,
  emptyState,
  reduced,
  swipe,
  onOpen,
  onClose,
  onExitComplete,
}: {
  desktop: boolean;
  pane: HostedConversationTarget | undefined;
  inlineTask: TaskTarget | undefined;
  phoneTask: TaskTarget | undefined;
  isTaskExpanded: boolean;
  onToggleTaskExpand: () => void;
  taskNavigation: TaskDetailNavigation | undefined;
  paneFlow: ActivityPaneFlow | undefined;
  emptyState: ReactNode;
  reduced: boolean;
  swipe: ReturnType<typeof useEdgeSwipeBack>;
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
  onExitComplete: () => void;
}) {
  return (
    <>
      {desktop ? (
        inlineTask ? (
          <ActivityTaskPopup
            key={inlineTask.id}
            target={inlineTask}
            onOpen={onOpen}
            onClose={onClose}
            inline
            expanded={isTaskExpanded}
            onToggleExpand={onToggleTaskExpand}
            navigation={taskNavigation}
            flow={paneFlow}
          />
        ) : pane ? (
          <ActivityConversationPane
            key={`${pane.kind}:${pane.id}`}
            target={pane}
            onOpen={onOpen}
            onClose={onClose}
            flow={paneFlow}
          />
        ) : (
          <ActivityInboxIdlePane emptyState={emptyState} />
        )
      ) : (
        <AnimatePresence initial={false} onExitComplete={onExitComplete}>
          {pane && (
            <motion.div
              key={`${pane.kind}:${pane.id}`}
              {...swipe.bind}
              initial={reduced ? { opacity: 0 } : { x: "100%" }}
              animate={
                reduced
                  ? { opacity: 1 }
                  : swipe.dragging
                    ? { x: `${swipe.dragProgress * 100}%` }
                    : { x: 0 }
              }
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: DURATION_S.reduced } }
                  : { x: "100%", transition: { duration: DURATION_S.lgOut, ease: EASE_IN } }
              }
              transition={
                swipe.dragging
                  ? { duration: 0 }
                  : reduced
                    ? { duration: DURATION_S.reduced }
                    : swipe.settling
                      ? { type: "spring", stiffness: 380, damping: 32 }
                      : { duration: DURATION_S.lg, ease: EASE_OUT }
              }
              className="fixed inset-x-0 top-0 z-40 flex h-[var(--app-height,100dvh)] min-h-0 min-w-0 touch-pan-y bg-primary pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left shadow-2xl"
            >
              <ActivityConversationPane
                target={pane}
                onOpen={onOpen}
                onClose={onClose}
                flow={paneFlow}
              />
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {phoneTask && (
        <ActivityTaskPopup
          key={phoneTask.id}
          target={phoneTask}
          onOpen={onOpen}
          onClose={onClose}
        />
      )}
    </>
  );
}
