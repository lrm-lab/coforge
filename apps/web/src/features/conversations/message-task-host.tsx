import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Heading } from "react-aria-components";
import { XClose } from "@untitledui/icons";
import type { TaskPriorityLevel } from "@lrm/coforge-sdk/internal";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { DialogAction, DialogActions } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useAppToast } from "#src/components/ui/toast";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { m } from "#src/paraglide/messages";
import { makeTaskFromMessage } from "#src/features/tasks/message-task.functions";
import { TaskPriorityMenu } from "#src/features/tasks/task-priority-menu";
import { useConversationTaskWrites } from "#src/features/tasks/use-conversation-tasks";
import { useLastTaskPriority } from "#src/features/settings/last-task-priority";
import { overviewTaskParam } from "#src/features/tasks/task-overview-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useOpenConversationTask } from "./open-conversation-thread";

type MakeTaskSource = { conversationId: string; messageId: string };
type MakeTask = (source: MakeTaskSource) => void;

const MakeTaskContext = createContext<MakeTask | null>(null);

export function useMakeTaskFromMessage(): MakeTask | null {
  return useContext(MakeTaskContext);
}

export function MessageTaskHost({ children }: { children: ReactNode }) {
  const make = useServerFn(makeTaskFromMessage);
  const writeTasks = useConversationTaskWrites();
  const { openTask } = useOpenConversationTask();
  const toast = useAppToast();
  const [taskPriority, setTaskPriority] = useLastTaskPriority();
  const params = useParams({ strict: false }) as { channelId?: string; dmId?: string };
  const hosted = useSearch({
    strict: false,
    select: (search) => (search as { open?: string }).open,
  });
  const shown = params.channelId ?? params.dmId ?? hosted?.split(":").at(-1);
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const show = (conversationId: string, number: number) =>
    conversationId === shown
      ? openTask(number)
      : toast.success(m.message_make_task_made({ number: String(number) }), {
          action: {
            label: m.action_open(),
            onClick: () =>
              void navigate({
                to: "/w/$workspaceSlug/projects",
                params: { workspaceSlug },
                search: { task: overviewTaskParam({ conversationId, number }) },
              }),
          },
        });
  const [pending, setPending] = useState<{ source: MakeTaskSource } | null>(null);
  const [making, setMaking] = useState(false);
  const makingRef = useRef(new Set<string>());
  const run = useLatestCallback<[MakeTaskSource, TaskPriorityLevel], Promise<boolean>>(
    async (source, priority) => {
      if (makingRef.current.has(source.messageId)) return false;
      makingRef.current.add(source.messageId);
      try {
        const { task } = await make({
          data: {
            ...source,
            idempotencyKey: crypto.randomUUID(),
            priority,
          },
        });
        writeTasks(source.conversationId, [{ tasks: [task], deleted: [] }]);
        show(source.conversationId, task.number);
        return true;
      } catch {
        toast.error(m.message_make_task_failed());
        return false;
      } finally {
        makingRef.current.delete(source.messageId);
      }
    },
  );
  const makeTask = useLatestCallback<Parameters<MakeTask>, void>((source) =>
    setPending({ source }),
  );
  const confirm = async () => {
    if (!pending || making) return;
    setMaking(true);
    try {
      await run(pending.source, taskPriority);
    } finally {
      setMaking(false);
      setPending(null);
    }
  };
  return (
    <MakeTaskContext value={makeTask}>
      {children}
      {pending && (
        <ModalOverlay isOpen onOpenChange={(open) => !open && !making && setPending(null)}>
          <Modal className="w-[calc(100vw-2rem)] max-w-md">
            <Dialog className="p-6">
              <ButtonUtility
                icon={XClose}
                size="sm"
                color="tertiary"
                aria-label={m.controls_close()}
                onClick={() => setPending(null)}
                isDisabled={making}
                className="absolute top-4 right-4"
              />
              <Heading slot="title" className="pr-8 text-lg font-semibold text-primary">
                {m.message_make_task()}
              </Heading>
              <div className="mt-4">
                <TaskPriorityMenu
                  priority={taskPriority}
                  disabled={making}
                  onSelect={setTaskPriority}
                  placement="top start"
                />
              </div>
              <DialogActions className="mt-5">
                <DialogAction
                  isLoading={making}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {m.message_make_task()}
                </DialogAction>
              </DialogActions>
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </MakeTaskContext>
  );
}
