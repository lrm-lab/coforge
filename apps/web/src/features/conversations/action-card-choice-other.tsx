import { useRef, useState } from "react";
import { Pencil01 } from "@untitledui/icons";
import { CHOICE_OTHER_OPTION_ID, CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import { Spinner } from "#src/components/ui/spinner";
import { cn } from "#src/lib/utils";
import { shouldSendOnEnter } from "./composer-behavior";

/** A key named on a row: an option's number, or Enter on the person's own answer. */
export const KEY_HINT =
  "grid h-5 shrink-0 place-items-center rounded-[5px] border border-secondary bg-primary font-body text-xs font-semibold text-tertiary";
/** The row a failed send was from, kept marked until the next one. */
export const FAILED_RING = "ring-2 ring-brand ring-inset";

/**
 * The person's own answer as the card's last row: a one-line input named by its placeholder. Enter
 * sends the words, as the composer's does: never while an input method is composing or just
 * confirming them, and never blank. It has no number and no border, so it does not read as one more
 * option; with focus it takes the brand ring and, once there are words, shows the Enter key.
 */
export function OtherRow({
  placeholder,
  picking,
  failed,
  onSend,
}: {
  placeholder: string;
  /** The option being sent, this row's (`_other`) included. */
  picking?: string;
  failed: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const composing = useRef(false);
  const lastCompositionEndAt = useRef<number | null>(null);
  const sending = picking === CHOICE_OTHER_OPTION_ID;
  const words = text.trim();
  return (
    <li>
      <label
        className={cn(
          // One more row, bordered like the options (Frank, 11-04: a filled block stood out).
          "group/other flex min-h-10 w-full cursor-text items-center gap-2 rounded-lg border border-secondary px-2.5 text-sm max-sm:min-h-11",
          "hover:bg-primary_hover focus-within:border-brand focus-within:hover:bg-transparent",
          failed && cn("border-transparent", FAILED_RING),
          picking && !sending && "opacity-50",
        )}
      >
        {sending ? (
          <Spinner className="size-4 shrink-0 text-fg-brand-primary" />
        ) : (
          <Pencil01
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-quaternary group-focus-within/other:text-fg-brand-primary"
          />
        )}
        <input
          data-choice-row=""
          data-choice-option={CHOICE_OTHER_OPTION_ID}
          type="text"
          value={text}
          aria-label={placeholder}
          placeholder={placeholder}
          maxLength={CHOICE_OTHER_TEXT_MAX_LENGTH}
          enterKeyHint="send"
          // Stays focusable while the answer is sent, so a failed send leaves the words here.
          readOnly={picking !== undefined}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            lastCompositionEndAt.current = Date.now();
          }}
          onKeyDown={(event) => {
            // Esc with words clears them; without, it leaves the row (the card's own Esc).
            if (event.key === "Escape" && text) {
              event.stopPropagation();
              setText("");
              return;
            }
            const enter = shouldSendOnEnter(
              {
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing || composing.current,
                keyCode: event.keyCode,
              },
              {
                lastCompositionEndAt: lastCompositionEndAt.current,
                now: Date.now(),
              },
            );
            if (event.key === "Enter") event.preventDefault();
            if (enter && words && !picking) void onSend(words);
          }}
          className="min-w-0 flex-1 bg-transparent py-2 text-primary outline-none placeholder:text-placeholder"
        />
        {words && !sending && (
          <kbd aria-hidden="true" className={cn(KEY_HINT, "px-1.5")}>
            Enter
          </kbd>
        )}
      </label>
    </li>
  );
}
