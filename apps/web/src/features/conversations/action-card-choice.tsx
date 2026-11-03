import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, Clock, Pencil01 } from "@untitledui/icons";
import { FocusScope, useFocusManager } from "react-aria";
import { Button as AriaButton } from "react-aria-components";
import { CHOICE_OTHER_OPTION_ID, CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import { Button } from "#src/components/base/buttons/button";
import { Spinner } from "#src/components/ui/spinner";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { focusDraftEnd } from "./composer-field";
import { shouldSendOnEnter } from "./composer-behavior";
import { HandledChoice, chosenAnswer } from "./action-card-choice-handled";

type ChoiceView = Extract<ActionCardView, { kind: "choice" }>;
type Pick = { optionId: string; text?: string };

/** The rows arrow keys move between: the options, then the person's own answer. */
const ROW = "[data-choice-row]";
/** A key named on a row: an option's number, or Enter on the person's own answer. */
const KEY_HINT =
  "grid h-5 shrink-0 place-items-center rounded-[5px] border border-secondary bg-primary font-body text-xs font-semibold text-tertiary";
/** The row a failed send was from, kept marked until the next one. */
const FAILED_RING = "ring-2 ring-brand ring-inset";
/** A card still waiting on the viewer, which focus moves on to once the one before it is answered. */
const WAITING_ON_VIEWER = "[data-choice-waiting]";

/**
 * An Agent's question while it waits is a tool: the question, one bordered row per option, and the
 * person's own answer as a last row that is itself an input. A click (or Enter, or the option's
 * number while the card has focus) sends it at once. Once handled it is no longer a card but one
 * line in the message: the question, then the answer (task #449). Anyone but the asked person sees
 * the options as a plain list and whom the card waits on.
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
  const [picking, setPicking] = useState<string>();
  // The last pick sent, kept so a failure can name the row it was and send it again.
  const [lastPick, setLastPick] = useState<Pick>();
  const pending = view.state === "pending";
  const executed = view.state === "executed";
  const cardRef = useRef<HTMLDivElement>(null);
  const wasPending = useRef(pending);
  const [announcement, setAnnouncement] = useState("");
  const answer = chosenAnswer(view);
  const isAsked = view.asked?.isViewer === true;
  // The asked person's pick replaces the card with its one line, unmounting the pressed row: focus
  // goes on to the next card waiting on them, or else to this line, which a screen reader reads.
  useEffect(() => {
    const closed = !pending && wasPending.current;
    wasPending.current = pending;
    const card = cardRef.current;
    if (!closed || !executed || !isAsked || !card) return;
    if (document.activeElement === document.body) {
      const next = [
        ...(card.closest("[data-conversation-pane]") ?? document).querySelectorAll<HTMLElement>(
          WAITING_ON_VIEWER,
        ),
      ].find((other) => card.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
      (next?.querySelector<HTMLElement>(ROW) ?? card).focus();
    }
    if (answer) setAnnouncement(m.action_card_choice_chosen({ option: answer }));
  }, [pending, executed, isAsked, answer]);

  async function pick(next: Pick) {
    if (picking) return;
    setPicking(next.optionId);
    setLastPick(next);
    try {
      await onPick(next.optionId, next.text);
    } finally {
      setPicking(undefined);
    }
  }

  /** Sends the failed pick again from its own row, which takes focus first: the alert holding Retry
   * goes while it is sent. The person's own answer is sent as it now reads. */
  function retry() {
    if (!lastPick) return;
    const row = cardRef.current?.querySelector<HTMLElement>(
      `[data-choice-option="${lastPick.optionId}"]`,
    );
    row?.focus();
    const words = row instanceof HTMLInputElement ? row.value.trim() : "";
    void pick(words ? { ...lastPick, text: words } : lastPick);
  }

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={view.prompt}
      tabIndex={-1}
      data-choice-waiting={pending && view.canCommit ? "" : undefined}
      className={cn(
        "outline-focus-ring focus-visible:outline-2",
        pending
          ? "group/card mt-1 flex max-w-md flex-col rounded-xl border border-secondary bg-primary px-1.5 pt-3 pb-1.5"
          : "rounded-sm",
      )}
    >
      {pending ? (
        // The scope gives the rows' arrow keys React Aria's focus manager.
        <FocusScope>
          <PendingChoice
            view={view}
            picking={picking}
            failed={error ? lastPick : undefined}
            error={error}
            cancelling={cancelling}
            onPick={pick}
            onRetry={retry}
            onCancel={onCancel}
          />
        </FocusScope>
      ) : (
        <HandledChoice view={view} answer={answer} />
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

/** The waiting card's question, rows and foot. */
function PendingChoice({
  view,
  picking,
  failed,
  cancelling,
  onPick,
  onRetry,
  onCancel,
  error,
}: {
  view: ChoiceView;
  picking?: string;
  /** The pick that just failed, kept marked until the next one. */
  failed?: Pick;
  /** Why the last request failed; a Dismiss that failed has no pick to mark. */
  error: string;
  cancelling: boolean;
  onPick: (pick: Pick) => Promise<void>;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const canAnswer = view.canCommit;
  // Whom it waits on, for anyone but the asked person; withdrawing is for the Agent's owner or an
  // admin, never the asked person, who answers or types instead.
  const waitingOn = canAnswer ? undefined : view.asked?.displayName;
  const withdrawable = view.canCancel && !canAnswer;

  const focus = useFocusManager();
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!canAnswer) return;
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Between the rows only (not the hint or Retry), round from the last to the first.
      event.preventDefault();
      const options = { wrap: true, accept: (node: Element) => node.matches(ROW) };
      if (event.key === "ArrowDown") focus?.focusNext(options);
      else focus?.focusPrevious(options);
      return;
    }
    if (event.key === "Escape") {
      // Focus goes back to the page; the card stays where it is.
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    // An option's number picks it, unless the person is writing their own answer.
    const index = Number(event.key) - 1;
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && view.options[index]) {
      event.preventDefault();
      void onPick({ optionId: view.options[index].id });
    }
  }

  return (
    // The card's keys work from any row in it.
    <div className="flex flex-col" onKeyDown={onKeyDown}>
      <p className="px-2.5 pb-2 text-sm font-semibold wrap-anywhere text-primary">{view.prompt}</p>
      {canAnswer ? (
        <ul className="flex flex-col gap-1.5">
          {view.options.map((option, index) => {
            const sending = picking === option.id;
            return (
              <li key={option.id}>
                <AriaButton
                  data-choice-row=""
                  data-choice-option={option.id}
                  aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
                  // Stays focusable while the pick is sent, so a failed pick leaves focus here.
                  aria-disabled={picking ? true : undefined}
                  onPress={() => void onPick({ optionId: option.id })}
                  className={cn(
                    "group/row flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-secondary px-2.5 py-2 text-left text-sm text-primary outline-focus-ring max-sm:min-h-11",
                    "hover:bg-primary_hover focus-visible:border-transparent focus-visible:outline-2 focus-visible:-outline-offset-1",
                    "aria-disabled:cursor-default aria-disabled:hover:bg-transparent",
                    failed?.optionId === option.id && cn("border-transparent", FAILED_RING),
                    picking && !sending && "opacity-50",
                  )}
                >
                  {sending && <Spinner className="size-4 shrink-0 text-fg-brand-primary" />}
                  <span className="min-w-0 flex-1 wrap-anywhere">{option.label}</span>
                  {index < 9 && (
                    // The number shows on the row under the pointer, and on every row while the
                    // card has keyboard focus.
                    <kbd
                      aria-hidden="true"
                      className={cn(
                        KEY_HINT,
                        "invisible min-w-5 px-1 tabular-nums group-hover/row:visible group-has-[[data-choice-row]:focus-visible]/card:visible",
                      )}
                    >
                      {index + 1}
                    </kbd>
                  )}
                </AriaButton>
              </li>
            );
          })}
          {view.other && (
            <OtherRow
              placeholder={view.other.label || m.action_card_choice_other()}
              picking={picking}
              failed={failed?.optionId === CHOICE_OTHER_OPTION_ID}
              onSend={(text) => onPick({ optionId: CHOICE_OTHER_OPTION_ID, text })}
            />
          )}
        </ul>
      ) : (
        <ul className="flex flex-col">
          {view.options.map((option) => (
            <li
              key={option.id}
              className="flex items-baseline gap-2.5 px-2.5 py-1 text-sm wrap-anywhere text-secondary"
            >
              <span
                aria-hidden="true"
                className="size-1 shrink-0 -translate-y-[0.3em] rounded-full bg-current text-fg-quaternary"
              />
              {option.label}
            </li>
          ))}
        </ul>
      )}
      {/* With no row of their own (the Agent turned it off), the asked person is pointed at the
          chat: the hint puts the caret in this conversation's composer, and the card waits on. */}
      {!view.other && canAnswer && (
        <AriaButton
          onPress={(event) => focusComposerOf(event.target)}
          className="self-start rounded-sm px-2.5 pt-2 pb-1 text-left text-xs text-quaternary outline-focus-ring hover:text-tertiary focus-visible:outline-2"
        >
          {m.action_card_choice_chat_hint()}
        </AriaButton>
      )}
      {error && !failed && (
        <p role="alert" className="px-2.5 pt-2 pb-1 text-sm text-error-primary">
          {error}
        </p>
      )}
      {failed && (
        <div
          role="alert"
          className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-sm text-error-primary"
        >
          <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{m.action_card_choice_failed()}</span>
          <Button
            size="sm"
            color="link-destructive"
            isDisabled={Boolean(picking)}
            onPress={onRetry}
          >
            {m.action_card_choice_retry()}
          </Button>
        </div>
      )}
      {(waitingOn || withdrawable) && (
        <div className="flex items-center gap-3 px-2.5 pt-2 pb-1">
          {waitingOn && (
            <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-tertiary">
              <Clock aria-hidden="true" className="size-3.5 shrink-0" />
              {m.action_card_choice_waiting({ name: waitingOn })}
            </p>
          )}
          {withdrawable && (
            <Button
              size="sm"
              color="link-gray"
              isDisabled={cancelling}
              onPress={onCancel}
              className="ml-auto"
            >
              {cancelling ? m.action_card_cancelling() : m.action_card_dismiss()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The person's own answer as the card's last row: a one-line input named by its placeholder. Enter
 * sends the words, as the composer's does: never while an input method is composing or just
 * confirming them, and never blank. It has no number and no border, so it does not read as one more
 * option; with focus it takes the brand ring and, once there are words, shows the Enter key.
 */
function OtherRow({
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
          "group/other flex min-h-10 w-full cursor-text items-center gap-2 rounded-lg bg-secondary px-2.5 text-sm max-sm:min-h-11",
          "focus-within:bg-primary focus-within:ring-1 focus-within:ring-brand focus-within:ring-inset",
          failed && cn("bg-primary", FAILED_RING),
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
              { lastCompositionEndAt: lastCompositionEndAt.current, now: Date.now() },
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

/** The composer of the conversation a card is in: the pane holding the card holds it too (a thread
 * pane beside the channel has its own). */
function focusComposerOf(from: EventTarget | null) {
  focusDraftEnd(
    (from instanceof Element ? from : null)
      ?.closest("[data-conversation-pane]")
      ?.querySelector<HTMLTextAreaElement>("textarea[data-composer]") ?? null,
  );
}
