import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
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
import { useTaskConversationsOn } from "#src/features/tasks/use-task-conversations-on";
import { useConversationTaskWrites } from "#src/features/tasks/use-conversation-tasks";
import { useLastTaskPriority } from "#src/features/settings/last-task-priority";
import { useOpenConversationTask } from "./open-conversation-thread";

type MakeTaskSource = { conversationId: string; messageId: string };
type MakeTask = (source: MakeTaskSource) => void;
type Taken = {
  source: MakeTaskSource;
  number: number;
  holder: string;
  /** The priority the Task was asked for with; "Create anyway" keeps it (task #12). */
  priority: TaskPriorityLevel;
};

const MakeTaskContext = createContext<MakeTask | null>(null);

/** Makes a Task from a message; null where no conversation host is above, or where task
 * conversations are off (a message there does not become a Task's source). Stable. */
export function useMakeTaskFromMessage(): MakeTask | null {
  return useContext(MakeTaskContext);
}

/**
 * "Make Task" on a message, for any row under the conversation host: asks the Task's priority
 * first (task #12 — it starts at the device's last pick), then makes a new Task with the message
 * as its source, opened in its popup once made. A message someone else's unfinished Task came
 * from asks first: open that Task, or make this one anyway, beside it.
 */
export function MessageTaskHost({ children }: { children: ReactNode }) {
  const on = useTaskConversationsOn();
  const make = useServerFn(makeTaskFromMessage);
  const writeTasks = useConversationTaskWrites();
  const { openTask } = useOpenConversationTask();
  const toast = useAppToast();
  // The priority the next make starts with, and the picker's value while its dialog is open.
  const [taskPriority, setTaskPriority] = useLastTaskPriority();
  // The conversation the page shows: Chat's by its path, a hosted pane's by `open`. A Task made
  // from a row of another (the Saved list's) is not opened over this one.
  const params = useParams({ strict: false }) as { channelId?: string; dmId?: string };
  const hosted = useSearch({
    strict: false,
    select: (search) => (search as { open?: string }).open,
  });
  const shown = params.channelId ?? params.dmId ?? hosted?.split(":").at(-1);
  const show = (conversationId: string, number: number) =>
    conversationId === shown
      ? openTask(number)
      : toast.success(m.message_make_task_made({ number: String(number) }));
  const [pending, setPending] = useState<{ source: MakeTaskSource } | null>(null);
  const [making, setMaking] = useState(false);
  const [taken, setTaken] = useState<Taken | null>(null);
  // One making per message at a time: a second press while one runs makes nothing more.
  const makingRef = useRef(new Set<string>());
  /** Whether the message now has the person's Task, or another's that they were asked about. */
  const run = useLatestCallback<[MakeTaskSource, TaskPriorityLevel, boolean?], Promise<boolean>>(
    async (source, priority, alongside) => {
      if (makingRef.current.has(source.messageId)) return false;
      makingRef.current.add(source.messageId);
      try {
        const made = await make({
          data: {
            ...source,
            idempotencyKey: crypto.randomUUID(),
            priority,
            alongside,
          },
        });
        if (made.taken) {
          setTaken({ source, priority, ...made.taken });
          return false;
        }
        const task = made.task!;
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
      // Made, failed (the toast said why) or taken (its dialog replaces this one): the pick is
      // done either way, and a retry opens the dialog again at the same remembered priority.
      setPending(null);
    }
  };
  return (
    <MakeTaskContext value={on ? makeTask : null}>
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
      {taken && (
        <TakenDialog
          taken={taken}
          onOpen={() => {
            setTaken(null);
            show(taken.source.conversationId, taken.number);
          }}
          onAlongside={async () => {
            if (await run(taken.source, taken.priority, true)) setTaken(null);
          }}
          onClose={() => setTaken(null)}
        />
      )}
    </MakeTaskContext>
  );
}

function TakenDialog({
  taken,
  onOpen,
  onAlongside,
  onClose,
}: {
  taken: Taken;
  onOpen: () => void;
  onAlongside: () => Promise<void>;
  onClose: () => void;
}) {
  const [making, setMaking] = useState(false);
  const number = String(taken.number);
  return (
    <ModalOverlay isOpen onOpenChange={(open) => !open && !making && onClose()}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          <ButtonUtility
            icon={XClose}
            size="sm"
            color="tertiary"
            aria-label={m.controls_close()}
            onClick={onClose}
            isDisabled={making}
            className="absolute top-4 right-4"
          />
          <Heading slot="title" className="pr-8 text-lg font-semibold text-primary">
            {m.message_make_task_taken({ number, holder: taken.holder })}
          </Heading>
          <DialogActions className="mt-5">
            <DialogAction color="secondary" onPress={onOpen} isDisabled={making}>
              {m.message_make_task_open({ number })}
            </DialogAction>
            <DialogAction
              isLoading={making}
              showTextWhileLoading
              onPress={() => {
                setMaking(true);
                void onAlongside().finally(() => setMaking(false));
              }}
            >
              {m.message_make_task_alongside()}
            </DialogAction>
          </DialogActions>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
