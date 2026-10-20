import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import type { DirectConversationView } from "./conversation-types";
import type { OutboxEntry } from "./composer-outbox";
import type { useMessageOutbox } from "./use-message-outbox";

/** Starter choices are ordinary member messages, with the composer's durable retry path. */
export function WorkspaceAssistantWelcome({
  conversation,
  entries,
  outbox,
  draftKey,
}: {
  conversation: Omit<DirectConversationView, "agent">;
  entries: readonly OutboxEntry[];
  outbox: ReturnType<typeof useMessageOutbox>;
  draftKey: string;
}) {
  if (
    !conversation.workspaceAssistantWelcome ||
    entries.length > 0 ||
    conversation.messages.some((message) => message.senderKind === "user") ||
    !conversation.messages.some((message) => message.senderKind === "agent")
  )
    return null;
  const choices = [
    m.workspace_assistant_choice_platform(),
    m.workspace_assistant_choice_tasks(),
    m.workspace_assistant_choice_messages(),
    m.workspace_assistant_choice_reminders(),
    m.workspace_assistant_choice_chat(),
  ];
  return (
    <section
      aria-label={m.workspace_assistant_welcome_question()}
      data-workspace-assistant-welcome
      className="mx-4 my-4 max-w-md rounded-2xl border border-secondary bg-primary p-4 md:ml-16"
    >
      <h2 className="mb-3 text-md font-semibold text-primary">
        {m.workspace_assistant_welcome_question()}
      </h2>
      <div className="flex flex-col gap-1">
        {choices.map((body, index) => (
          <Button
            key={body}
            color="tertiary"
            size="md"
            className="w-full justify-start whitespace-normal text-left"
            onPress={() => {
              const id = crypto.randomUUID();
              outbox.send(
                {
                  localId: id,
                  draftKey,
                  idempotencyKey: id,
                  body,
                  pins: [],
                  asTask: false,
                  attachments: [],
                },
                [],
              );
            }}
          >
            <span className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-sm text-tertiary"
              >
                {String.fromCharCode(65 + index)}
              </span>
              <span>{body}</span>
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}
