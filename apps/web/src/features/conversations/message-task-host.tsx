import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Heading } from "react-aria-components";
import { XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useAppToast } from "#src/components/ui/toast";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import {
  loadTaskConversationsOn,
  makeTaskFromMessage,
} from "#src/features/tasks/message-task.functions";
import { useConversationTaskWrites } from "#src/features/tasks/use-conversation-tasks";
import { useOpenConversationTask } from "./open-conversation-thread";

type MakeTask = (source: { conversationId: string; messageId: string }) => void;
type Taken = {
  source: Parameters<MakeTask>[0];
  number: number;
  holder: string;
};

const MakeTaskContext = createContext<MakeTask | null>(null);

/** Makes a Task from a message; null where no conversation host is above, or where task
 * conversations are off (a message there does not become a Task's source). Stable. */
export function useMakeTaskFromMessage(): MakeTask | null {
  return useContext(MakeTaskContext);
}

/**
 * "Make Task" on a message, for any row under the conversation host: a new Task with the message
 * as its source, opened in its popup once made. A message someone else's unfinished Task came from
 * asks first: open that Task, or make this one anyway, beside it.
 */
export function MessageTaskHost({ children }: { children: ReactNode }) {
  const loadOn = useServerFn(loadTaskConversationsOn);
  const workspaceId = useCurrentWorkspaceId();
  const on = useQuery({
    queryKey: ["task-conversations-on", workspaceId],
    queryFn: () => loadOn(),
    // Read again on a page's next host after a minute, so a switch in Settings shows here.
    staleTime: 60_000,
  }).data?.on;
  const make = useServerFn(makeTaskFromMessage);
  const writeTasks = useConversationTaskWrites();
  const { openTask } = useOpenConversationTask();
  const toast = useAppToast();
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
  const [taken, setTaken] = useState<Taken | null>(null);
  // One making per message at a time: a second press while one runs makes nothing more.
  const making = useRef(new Set<string>());
  /** Whether the message now has the person's Task, or another's that they were asked about. */
  const run = useLatestCallback<[Parameters<MakeTask>[0], boolean?], Promise<boolean>>(
    async (source, alongside) => {
      if (making.current.has(source.messageId)) return false;
      making.current.add(source.messageId);
      try {
        const made = await make({
          data: { ...source, idempotencyKey: crypto.randomUUID(), alongside },
        });
        if (made.taken) {
          setTaken({ source, ...made.taken });
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
        making.current.delete(source.messageId);
      }
    },
  );
  const makeTask = useLatestCallback<Parameters<MakeTask>, void>((source) => void run(source));
  return (
    <MakeTaskContext value={on ? makeTask : null}>
      {children}
      {taken && (
        <TakenDialog
          taken={taken}
          onOpen={() => {
            setTaken(null);
            show(taken.source.conversationId, taken.number);
          }}
          onAlongside={async () => {
            if (await run(taken.source, true)) setTaken(null);
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
          <div className="mt-5 flex justify-end gap-3">
            <Button color="secondary" size="sm" onPress={onOpen} isDisabled={making}>
              {m.message_make_task_open({ number })}
            </Button>
            <Button
              color="primary"
              size="sm"
              isLoading={making}
              showTextWhileLoading
              onPress={() => {
                setMaking(true);
                void onAlongside().finally(() => setMaking(false));
              }}
            >
              {m.message_make_task_alongside()}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
