import type { createSession } from "@coforge/agent";
import type { PiSessionEvent } from "./session-events";

type SdkSession = Awaited<ReturnType<typeof createSession>>["session"];
type SdkExtension = NonNullable<Parameters<typeof createSession>[1]>;

const providerFinishError = "Provider finish_reason: error";

export function createPiFinishErrorRecovery() {
  let streamedOutput = false;
  let attempted = false;
  let unsubscribe: (() => void) | undefined;
  let register: ((isCancelled: () => boolean) => () => void) | undefined;

  function clearBoundary() {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  const extension: SdkExtension = (pi) => {
    register = (isCancelled) =>
      pi.on("agent_before_settle", (event, context) => {
        clearBoundary();
        if (event.outcome !== "error" || isCancelled() || context.signal?.aborted) return;
        attempted = true;
        return {
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "pi-provider-finish-error",
              content:
                "The previous response ended with a provider error before producing any output. Continue from the tool results above.",
              display: false,
            },
          ],
          continue: true,
        };
      });
  };

  return {
    extension,
    observe(event: PiSessionEvent, session: SdkSession, isCancelled: () => boolean) {
      if (event.type === "agent_settled") {
        attempted = false;
        clearBoundary();
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        streamedOutput = false;
        clearBoundary();
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        switch (update.type) {
          case "text_delta":
          case "thinking_delta":
            streamedOutput ||= update.delta.length > 0;
            break;
          case "thinking_end": {
            const thinking = update.partial.content[update.contentIndex];
            streamedOutput ||=
              update.content.length > 0 ||
              (thinking?.type === "thinking" && Boolean(thinking.thinkingSignature));
            break;
          }
          case "toolcall_start":
          case "toolcall_delta":
          case "toolcall_end":
            streamedOutput = true;
            break;
        }
      } else if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error" &&
        event.message.errorMessage === providerFinishError &&
        !attempted &&
        !streamedOutput &&
        session.messages.at(-2)?.role === "toolResult" &&
        !event.message.content.some((part) => {
          switch (part.type) {
            case "toolCall":
              return true;
            case "text":
              return part.text.length > 0;
            case "thinking":
              return part.thinking.length > 0 || Boolean(part.thinkingSignature);
          }
        })
      ) {
        unsubscribe = register?.(isCancelled);
      }
    },
  };
}
