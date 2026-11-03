import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { CHOICE_OTHER_OPTION_ID, CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import { Button } from "#src/components/base/buttons/button";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { choiceLetter } from "./choice-letter";
import { focusDraftEnd } from "./composer-field";
import { shouldSendOnEnter } from "./composer-behavior";

type ChoiceView = Extract<ActionCardView, { kind: "choice" }>;

/**
 * An Agent's question with lettered options. The asked person picks one and the card closes on it:
 * the question, then the chosen option alone. Everyone else reads the options and whom the card
 * waits on. No header or status line: the question is the card. Unless the Agent turned it off,
 * the last lettered row is the person's own answer, as Grok's is: the row is itself an input, and
 * Enter sends what they wrote (`OtherRow`).
 */
export function ChoiceActionCard({
  view,
  error,
  cancelling,
  onPick,
  onCancel,
}: {
  view: ChoiceView;
  error: string;
  cancelling: boolean;
  /** Resolves once the pick is stored (or failed); the card then shows what the server says. The
   * person's own answer is `_other` with their words. */
  onPick: (optionId: string, text?: string) => Promise<void>;
  onCancel: () => void;
}) {
  // The option being sent: it reads as chosen at once, and the others wait, until the card returns.
  const [picking, setPicking] = useState<string>();
  const executed = view.state === "executed";
  const chosen = executed ? view.result?.optionId : picking;
  // The asked person's pick closes the card and removes the pressed option: focus, left on
  // nothing, moves to the card, and the status line tells a screen reader what was chosen.
  const cardRef = useRef<HTMLDivElement>(null);
  const wasExecuted = useRef(executed);
  const [announcement, setAnnouncement] = useState("");
  const answeredOther = view.result?.optionId === CHOICE_OTHER_OPTION_ID;
  const chosenIndex = answeredOther
    ? view.options.length
    : view.options.findIndex((option) => option.id === view.result?.optionId);
  // The person's own answer is their words; a stored one without them falls back to its label.
  const chosenLabel = answeredOther
    ? (view.result?.text ?? view.result?.label)
    : view.options[chosenIndex]?.label;
  const isAsked = view.asked?.isViewer === true;
  useEffect(() => {
    const closed = executed && !wasExecuted.current;
    wasExecuted.current = executed;
    if (!closed || !isAsked || chosenIndex < 0) return;
    if (document.activeElement === document.body) cardRef.current?.focus();
    setAnnouncement(
      m.action_card_choice_chosen({ option: `${choiceLetter(chosenIndex)}. ${chosenLabel ?? ""}` }),
    );
  }, [executed, isAsked, chosenIndex, chosenLabel]);
  // Whom it waits on, for anyone but the asked person; whom it was answered by, likewise.
  const waitingOn =
    view.state === "pending" && !view.canCommit ? view.asked?.displayName : undefined;
  const answeredBy = executed && !view.asked?.isViewer ? view.committedBy?.displayName : undefined;
  // The asked person answers or types instead; withdrawing is for the Agent's owner or an admin.
  const withdrawable = view.canCancel && !view.canCommit;
  /** One send at a time, an option's or the person's own words. */
  async function pick(optionId: string, text?: string) {
    if (picking) return;
    setPicking(optionId);
    try {
      await onPick(optionId, text);
    } finally {
      setPicking(undefined);
    }
  }
  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={view.prompt}
      tabIndex={-1}
      className={cn(
        "mt-1 flex max-w-md flex-col gap-2 rounded-xl border border-secondary bg-primary p-3 shadow-xs outline-focus-ring focus-visible:outline-2",
        view.state === "cancelled" && "opacity-60",
      )}
    >
      <p className="px-1 text-sm font-medium wrap-anywhere text-primary">{view.prompt}</p>
      <ul className="flex flex-col">
        {view.options.map((option, index) => {
          const isChosen = option.id === chosen;
          if (executed && !isChosen) return null;
          const row = (
            <RowContent
              letter={choiceLetter(index)}
              chosen={isChosen}
              quiet={Boolean(picking)}
              text={option.label}
              answeredBy={answeredBy}
            />
          );
          return (
            <li key={option.id}>
              {view.canCommit ? (
                <AriaButton
                  aria-label={`${choiceLetter(index)}. ${option.label}`}
                  // Stays focusable while the pick is sent, so a failed pick leaves focus here.
                  aria-disabled={picking ? true : undefined}
                  onPress={() => pick(option.id)}
                  className={cn(
                    "group flex w-full cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5 text-left outline-focus-ring focus-visible:outline-2",
                    "hover:bg-primary_hover aria-disabled:cursor-default aria-disabled:hover:bg-transparent",
                    picking && !isChosen && "opacity-50",
                  )}
                >
                  {row}
                </AriaButton>
              ) : (
                <div className="flex items-start gap-3 px-1 py-1.5">{row}</div>
              )}
            </li>
          );
        })}
        {view.other && (!executed || answeredOther) && (
          <OtherRow
            letter={choiceLetter(view.options.length)}
            placeholder={view.other.label || m.action_card_choice_other()}
            answer={answeredOther ? chosenLabel : undefined}
            answeredBy={answeredBy}
            canAnswer={view.canCommit && !executed}
            picking={picking}
            onSend={(text) => pick(CHOICE_OTHER_OPTION_ID, text)}
          />
        )}
      </ul>
      {/* With no row of their own (the Agent turned it off), the asked person is pointed at the
          chat: the hint puts the caret in this conversation's composer, and the card waits on. */}
      {!view.other && view.canCommit && (
        <AriaButton
          onPress={() => focusComposerOf(cardRef.current)}
          className="self-start rounded-sm px-1 text-left text-xs text-quaternary outline-focus-ring hover:text-tertiary focus-visible:outline-2"
        >
          {m.action_card_choice_chat_hint()}
        </AriaButton>
      )}
      {error && (
        <p role="alert" className="px-1 text-sm text-error-primary">
          {error}
        </p>
      )}
      {/* Whom it waits on and the way to withdraw it, on one line. */}
      {(waitingOn || withdrawable) && (
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-xs text-tertiary">
            {waitingOn && m.action_card_choice_waiting({ name: waitingOn })}
          </p>
          {withdrawable && (
            <Button size="sm" color="link-gray" isDisabled={cancelling} onPress={onCancel}>
              {cancelling ? m.action_card_cancelling() : m.action_card_dismiss()}
            </Button>
          )}
        </div>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {view.state === "cancelled" && (
        <p className="px-1 text-xs text-tertiary">{m.action_card_cancelled()}</p>
      )}
    </div>
  );
}

/** A row's letter and text; the chosen row's letter is filled, and hover marks it while nothing
 * is being sent. The person's own row also marks it while its input has focus. */
function RowContent({
  letter,
  chosen,
  quiet,
  text,
  placeholder = false,
  answeredBy,
  typing,
}: {
  letter: string;
  chosen: boolean;
  quiet: boolean;
  text?: ReactNode;
  /** The text is the own-answer row's name, not an answer. */
  placeholder?: boolean;
  answeredBy?: string;
  /** The own-answer row's input, in place of the text. */
  typing?: ReactNode;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
          chosen
            ? "bg-brand-solid text-white"
            : "bg-secondary text-tertiary ring-1 ring-secondary ring-inset",
          !quiet &&
            !chosen &&
            "group-hover:bg-primary group-hover:text-brand-secondary group-hover:ring-brand",
          typing &&
            !quiet &&
            "group-focus-within:bg-primary group-focus-within:text-brand-secondary group-focus-within:ring-brand",
        )}
      >
        {letter}
      </span>
      {typing ?? (
        // Row tops align: the letter sits beside the text's first line, however many it wraps to.
        <span
          className={cn(
            "mt-0.5 min-w-0 flex-1 text-sm wrap-anywhere",
            placeholder ? "text-placeholder" : "text-primary",
          )}
        >
          {text}
        </span>
      )}
      {answeredBy && <span className="mt-1 shrink-0 text-xs text-tertiary">{answeredBy}</span>}
    </>
  );
}

/**
 * The person's own answer as the card's last lettered row. For the asked person it is a one-line
 * input whose placeholder names it ("Something else"); Enter sends the words, as the composer's
 * does: never while an input method is composing or just confirming them, and never blank. The
 * row's background and letter show its focus; the caret is the rest. Anyone else sees the row,
 * inert, as they see the options. Answered, it is the letter and the words.
 */
function OtherRow({
  letter,
  placeholder,
  answer,
  answeredBy,
  canAnswer,
  picking,
  onSend,
}: {
  letter: string;
  placeholder: string;
  answer?: string;
  answeredBy?: string;
  canAnswer: boolean;
  /** The option being sent, this row's (`_other`) included. */
  picking?: string;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const composing = useRef(false);
  const lastCompositionEndAt = useRef<number | null>(null);
  const sending = picking === CHOICE_OTHER_OPTION_ID;
  if (answer !== undefined || !canAnswer)
    return (
      <li className="flex items-start gap-3 px-1 py-1.5">
        <RowContent
          letter={letter}
          chosen={answer !== undefined}
          quiet
          text={answer ?? placeholder}
          placeholder={answer === undefined}
          answeredBy={answeredBy}
        />
      </li>
    );
  return (
    <li>
      <label
        className={cn(
          "group flex w-full cursor-text items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-primary_hover focus-within:bg-primary_hover",
          picking && !sending && "opacity-50",
        )}
      >
        <RowContent
          letter={letter}
          chosen={sending}
          quiet={Boolean(picking)}
          typing={
            <input
              type="text"
              value={text}
              aria-label={`${letter}. ${placeholder}`}
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
                const enter = shouldSendOnEnter(
                  {
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing || composing.current,
                    keyCode: event.keyCode,
                  },
                  { lastCompositionEndAt: lastCompositionEndAt.current, now: Date.now() },
                );
                if (event.key === "Enter") event.preventDefault();
                const words = text.trim();
                if (enter && words && !picking) void onSend(words);
              }}
              className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-placeholder"
            />
          }
        />
      </label>
    </li>
  );
}

/** The composer of the conversation a card is in: the pane holding the card holds it too (a thread
 * pane beside the channel has its own). */
function focusComposerOf(card: HTMLElement | null) {
  focusDraftEnd(
    card
      ?.closest("[data-conversation-pane]")
      ?.querySelector<HTMLTextAreaElement>("textarea[data-composer]") ?? null,
  );
}
