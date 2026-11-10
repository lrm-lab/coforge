import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle } from "@untitledui/icons";
import type { OpenPersonProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { FocusScope, useFocusManager } from "react-aria";
import { Button as AriaButton } from "react-aria-components";
import { CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { Spinner } from "#src/components/ui/spinner";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { focusDraftEnd } from "./composer-field";
import { HandledChoice, chosenAnswer } from "./action-card-choice-handled";
import { WaitingOn } from "./action-card-waiting-on";
import { FAILED_RING, KEY_HINT, OtherRow } from "./action-card-choice-other";
import { focusIgnore, IgnoredLine } from "./action-card-ignored";
import { useUndoableIgnore } from "./use-undoable-ignore";

type ChoiceView = Extract<ActionCardView, { kind: "choice" }>;
type Pick = { optionId: string; text?: string };

/** The rows arrow keys move between: the options, then the person's own answer. */
const ROW = "[data-choice-row]";
/** A card still waiting on the viewer, which focus moves on to once the one before it is answered. */
const WAITING_ON_VIEWER = "[data-choice-waiting]";

/**
 * An Agent's question while it waits is a tool: the question, one bordered row per option, and the
 * person's own answer as a last row that is itself an input. A click (or Enter, or the option's
 * number while the card has focus) sends it at once. Once handled it stays a card, the question
 * over the answer (task #449, Frank 11-04). Anyone but the asked person sees
 * the options as a plain list and whom the card waits on.
 */
export function ChoiceActionCard({
  view,
  error,
  cancelling,
  onPick,
  onCancel,
  onIgnore,
  onOpenPersonProfile,
}: {
  view: ChoiceView;
  error: string;
  cancelling: boolean;
  /** Cancels the card for the asked person, once their ignore has not been undone. */
  onIgnore: (options: { keepalive: boolean }) => Promise<void>;
  /** Resolves once the pick is stored (or failed); the card then shows what the server says. The
   * person's own answer is `_other` with their words. */
  onPick: (optionId: string, text?: string) => Promise<void>;
  onCancel: () => void;
  /** Opens a person's profile from the card, where the conversation can. */
  onOpenPersonProfile?: OpenPersonProfile;
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
  const canIgnore = pending && view.canCommit && view.canCancel;
  const { ignored, ignore, undo } = useUndoableIgnore(onIgnore, canIgnore);
  const wasIgnored = useRef(false);
  // The collapsed line takes focus on Undo; coming back (undone, or the cancel failed), on Ignore.
  useEffect(() => {
    if (ignored) {
      focusIgnore(cardRef.current, "undo");
      setAnnouncement(m.action_card_ignored_status());
    } else if (wasIgnored.current) {
      setAnnouncement("");
      // Answered or cancelled elsewhere meanwhile, Ignore is gone with Undo: the card keeps focus.
      if (canIgnore) focusIgnore(cardRef.current, "ignore");
      else if (document.activeElement === document.body) cardRef.current?.focus();
    }
    wasIgnored.current = ignored;
  }, [ignored, canIgnore]);
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

  /** With the card itself focused, as it is when the card before it was just answered: a number
   * picks its option, and an arrow key goes to the first or last row (task #457). */
  function onCardKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== cardRef.current || !pending || !view.canCommit || ignored) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = [...(cardRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      (event.key === "ArrowDown" ? rows[0] : rows.at(-1))?.focus();
      return;
    }
    const option = view.options[Number(event.key) - 1];
    if (option) {
      event.preventDefault();
      void pick({ optionId: option.id });
    }
  }

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={view.prompt}
      tabIndex={-1}
      onKeyDown={onCardKeyDown}
      data-no-row-tap
      data-choice-waiting={pending && view.canCommit && !ignored ? "" : undefined}
      className={cn(
        "outline-focus-ring focus-visible:outline-2",
        "mt-1 flex max-w-md flex-col rounded-xl border border-secondary bg-primary",
        pending && "group/card px-1.5 pt-3 pb-1.5",
      )}
    >
      {pending ? (
        // The scope gives the rows' arrow keys React Aria's focus manager.
        <FocusScope>
          {ignored && (
            <>
              <ChoicePrompt prompt={view.prompt} />
              <IgnoredLine onUndo={undo} />
            </>
          )}
          {/* Kept mounted while collapsed, so an Undo restores the card as it was. */}
          <div hidden={ignored}>
            <PendingChoice
              view={view}
              picking={picking}
              failed={error ? lastPick : undefined}
              error={error}
              cancelling={cancelling}
              onPick={pick}
              onRetry={retry}
              onCancel={onCancel}
              onIgnore={canIgnore ? ignore : undefined}
              onOpenPersonProfile={onOpenPersonProfile}
            />
          </div>
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
  onIgnore,
  error,
  onOpenPersonProfile,
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
  /** Set for the asked person, who may ignore the card (and undo it for a few seconds). */
  onIgnore?: () => void;
  onOpenPersonProfile?: OpenPersonProfile;
}) {
  const canAnswer = view.canCommit;
  // Whom it waits on, for anyone but the asked person; withdrawing is for the Agent's owner or an
  // admin, never the asked person, who answers or types instead.
  const waitingOn = canAnswer ? undefined : view.asked;
  const withdrawable = view.canCancel && !canAnswer;

  const focus = useFocusManager();
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!canAnswer) return;
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Between the rows only (not the hint or Retry), round from the last to the first.
      event.preventDefault();
      const options = {
        wrap: true,
        accept: (node: Element) => node.matches(ROW),
      };
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
      <ChoicePrompt prompt={view.prompt} />
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
                    // The number that picks the row, always shown (task #457).
                    <kbd aria-hidden="true" className={cn(KEY_HINT, "min-w-5 px-1 tabular-nums")}>
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
          chat: the hint puts the caret in this conversation's composer, and the card waits on.
          Ignore sits at the right end of the same row, or alone on it. */}
      {((!view.other && canAnswer) || onIgnore) && (
        <div className="flex items-center gap-3 px-2.5 pt-2 pb-1">
          {!view.other && canAnswer && (
            <AriaButton
              onPress={(event) => focusComposerOf(event.target)}
              className="rounded-sm text-left text-xs text-quaternary outline-focus-ring hover:text-tertiary focus-visible:outline-2"
            >
              {m.action_card_choice_chat_hint()}
            </AriaButton>
          )}
          {onIgnore && (
            <Button
              data-ignore=""
              size="sm"
              color="link-gray"
              onPress={onIgnore}
              className="ml-auto"
            >
              {m.action_card_ignore()}
            </Button>
          )}
        </div>
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
            {m.action_card_retry()}
          </Button>
        </div>
      )}
      {(waitingOn || withdrawable) && (
        <div className="flex items-center gap-3 px-2.5 pt-2 pb-1">
          {waitingOn && <WaitingOn asked={waitingOn} onOpenPersonProfile={onOpenPersonProfile} />}
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
 * The question, cut to two lines (task #457), as the handled card's is: the whole of it shows on
 * hover, and a press on a cut question opens it out. The card's group is named by the whole
 * question, so a screen reader always hears all of it.
 */
function ChoicePrompt({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  // The question's element, as state: it moves into a button once cut, and the measuring follows.
  const [questionEl, setQuestionEl] = useState<HTMLSpanElement | null>(null);
  // Whether the two lines cut the question, measured again as the card's width changes.
  useLayoutEffect(() => {
    const question = questionEl;
    if (!question || expanded) return;
    const measure = () => setCut(question.scrollHeight > question.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(question);
    return () => observer.disconnect();
  }, [questionEl, expanded]);
  const question = (
    <span
      ref={setQuestionEl}
      data-choice-question=""
      className={cn("block", !expanded && "line-clamp-2")}
    >
      {prompt}
    </span>
  );
  return (
    <div className="px-2.5 pb-2 text-sm font-semibold wrap-anywhere text-primary">
      {cut && !expanded ? (
        <Tooltip title={prompt}>
          <AriaButton
            // Named by the question itself; `aria-expanded` says there is more of it.
            aria-expanded={false}
            onPress={() => setExpanded(true)}
            className="block w-full cursor-pointer rounded-sm text-left outline-focus-ring focus-visible:outline-2"
          >
            {question}
          </AriaButton>
        </Tooltip>
      ) : (
        question
      )}
    </div>
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
