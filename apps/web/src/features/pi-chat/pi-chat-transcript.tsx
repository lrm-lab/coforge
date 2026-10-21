import { ChevronDown, ChevronRight, Stars01, User01 } from "@untitledui/icons";
import type { PiChatMessage as Message } from "@lrm/coforge-sdk/internal/pi-chat";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { PiChatMessage } from "./pi-chat-message";
import { usePiChatDisclosure } from "./pi-chat-disclosure";

/** Group each user turn so execution details do not drown out the answer. */
export function PiChatTranscript({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const turns: Message[][] = [];
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return turns.map((turn, index) => (
    <Turn key={turn[0]!.id} messages={turn} busy={busy && index === turns.length - 1} />
  ));
}

function Turn({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const { open: expanded, toggle } = usePiChatDisclosure(`turn:${messages[0]!.id}`);
  const user = messages[0]?.role === "user" ? messages[0] : undefined;
  const responses = messages.slice(user ? 1 : 0);
  const last = responses.at(-1);
  const answer =
    last?.role === "assistant" && !last.toolCalls?.length && last.text ? last : undefined;
  const process = answer ? responses.slice(0, -1) : responses;
  const failed = responses.some((message) => message.isError);
  const calls = new Set<string>();
  for (const message of responses) {
    for (const tool of message.toolCalls ?? []) calls.add(tool.id);
    if (message.toolCallId) calls.add(message.toolCallId);
  }
  return (
    <div className="space-y-6 py-4 md:space-y-8 md:py-5">
      {user && (
        <article aria-label={m.pi_chat_you()} className="flex min-w-0 gap-3">
          <Avatar size="xs" placeholderIcon={User01} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-sm font-semibold text-primary">{m.pi_chat_you()}</p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-primary wrap-anywhere">
              {user.text}
            </p>
          </div>
        </article>
      )}
      {(responses.length > 0 || busy) && (
        <article aria-label={m.pi_chat_assistant()} className="flex min-w-0 gap-3">
          <Avatar size="xs" placeholderIcon={Stars01} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-sm font-semibold text-primary">{m.pi_chat_assistant()}</p>
            {process.length > 0 && (
              <div className="mb-3">
                <Button
                  color="tertiary"
                  size="sm"
                  iconLeading={expanded ? ChevronDown : ChevronRight}
                  aria-expanded={expanded}
                  onClick={toggle}
                  className={cn("-ml-3 max-w-full text-tertiary", failed && "text-error-primary")}
                >
                  {calls.size
                    ? m.pi_chat_process_tools({ count: String(calls.size) })
                    : m.pi_chat_process()}
                  {failed && <span> · {m.pi_chat_tool_failed()}</span>}
                </Button>
                {expanded && (
                  <div className="mt-2 space-y-3 border-l border-secondary pl-3">
                    {process.map((message) => (
                      <PiChatMessage key={message.id} message={message} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {answer && <PiChatMessage message={answer} />}
            {busy && (
              <p role="status" className="mt-3 flex items-center gap-2 text-xs text-tertiary">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-brand-solid" />
                {m.pi_chat_running()}
              </p>
            )}
          </div>
        </article>
      )}
    </div>
  );
}
