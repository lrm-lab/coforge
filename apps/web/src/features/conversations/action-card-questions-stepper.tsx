import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { answered, QuestionRows, type Draft, type Question } from "./action-card-question-rows";
import {
  isTextEntry,
  releaseQuestionsCard,
  setActiveQuestionsCard,
  useIsActiveQuestionsCard,
} from "./action-card-questions-active";
import { moveStep } from "./action-card-questions-steps";
import { useQuestionSwipe } from "./use-question-swipe";

/** A single pick moves on once its key has filled. */
const AUTO_NEXT_MS = 180;

/**
 * The questions answered one at a time (task #515), as clean as Grok's question card (Frank,
 * 11-04): the question and its keyed rows, and under them a dot per question with Previous, Skip
 * or Next, and Submit on the last. A single pick moves on by itself; several picks or the person's
 * own words wait for Next. 1–9 picks, ← → and a sideways swipe turn the questions, Enter goes on
 * and, on the last, sends; a dot goes straight to its question.
 */
export function QuestionsStepper({
  questions,
  drafts,
  disabled,
  canSubmit,
  submitting,
  onChange,
  onSubmit,
  notice,
  action,
  readOnly,
}: {
  questions: Question[];
  drafts: Record<string, Draft>;
  disabled: boolean;
  canSubmit: boolean;
  submitting: boolean;
  onChange: (questionId: string, draft: Draft) => void;
  onSubmit: () => void;
  /** What the card has to say over its buttons: why the last send failed. */
  notice?: ReactNode;
  /** A quieter control of the card's own, first in the buttons' row: its Ignore (task #91). */
  action?: ReactNode;
  /** Answered (Frank, 11-04): the same pages, each pick marked; the dots and ‹ › turn them, as
   * ← → and a swipe do (task #531: with the dots alone, nothing showed the way). */
  readOnly?: boolean;
}) {
  const last = questions.length - 1;
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  // A question a finger brought in is already in place: it does not slide in again.
  const [swiped, setSwiped] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const autoNext = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(autoNext.current), []);
  // The card ← → turn while focus is elsewhere: the one under the pointer or last focused.
  const [self] = useState(() => Symbol("questions card"));
  const active = useIsActiveQuestionsCard(self);
  useEffect(() => () => releaseQuestionsCard(self), [self]);
  // A question turned from inside the card keeps focus in it: the row pressed went with its step.
  const focusFollows = useRef(false);
  useEffect(() => {
    if (!focusFollows.current) return;
    focusFollows.current = false;
    body.current?.focus({ preventScroll: true });
  }, [step]);

  const goTo = (next: number, bySwipe = false) => {
    clearTimeout(autoNext.current);
    const clamped = moveStep(next, 0, last);
    if (clamped === step) return;
    setDirection(clamped > step ? 1 : -1);
    setSwiped(bySwipe);
    focusFollows.current = Boolean(card.current?.contains(document.activeElement));
    setStep(clamped);
  };
  // Active, the arrows turn this card from anywhere on the page but a text field or another
  // control that keeps its own arrows; inside the card, its own handler takes them.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (isTextEntry(target)) return;
      if (target instanceof Node && card.current?.contains(target)) return;
      if (target instanceof Element && target.closest(ARROW_OWNERS)) return;
      event.preventDefault();
      goTo(step + (event.key === "ArrowRight" ? 1 : -1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const swipe = useQuestionSwipe({
    pages,
    hasNext: step < last,
    hasPrevious: step > 0,
    onTurn: (delta) => goTo(step + delta, true),
  });
  const question = questions[step];
  if (!question) return null;
  const isLast = step === last;
  const done = answered(drafts[question.id]);
  // Only an answered card has questions left unanswered; one still waiting has none answered yet.
  const anyAnswered = questions.some((entry) => answered(drafts[entry.id]));

  const pick = (draft: Draft) => {
    if (readOnly) return;
    onChange(question.id, draft);
    // One pick answers a single-pick question: on to the next.
    if (!isLast && question.select === "one" && draft.selection.length && !draft.text.trim()) {
      clearTimeout(autoNext.current);
      autoNext.current = setTimeout(() => goTo(step + 1), AUTO_NEXT_MS);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!isLast) return goTo(step + 1);
      if (canSubmit && !submitting) onSubmit();
      return;
    }
    if (event.target instanceof HTMLInputElement || disabled) return;
    const index = Number(event.key) - 1;
    const option = question.options[index];
    if (option) {
      event.preventDefault();
      if (question.select === "one") return pick({ selection: [option.id], text: "" });
      const draft = drafts[question.id] ?? { selection: [], text: "" };
      const selection = draft.selection.includes(option.id)
        ? draft.selection.filter((id) => id !== option.id)
        : [...draft.selection, option.id];
      return pick({ ...draft, selection });
    }
    // The key after the options goes to the person's own words.
    if (question.other && index === question.options.length) {
      event.preventDefault();
      body.current?.querySelector<HTMLInputElement>("[data-question-other]")?.focus();
    }
  };
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // The person's own words keep their arrows for the caret.
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    event.stopPropagation();
    goTo(step + (event.key === "ArrowRight" ? 1 : -1));
  };
  // A question's page: its prompt, its note, and its keyed rows.
  const page = (entry: Question, onPick: (draft: Draft) => void) => {
    const entryDone = answered(drafts[entry.id]);
    return (
      <>
        <div className="flex items-baseline gap-2 px-2 text-sm">
          <p className="min-w-0 flex-1 font-semibold wrap-anywhere text-primary">{entry.prompt}</p>
          {readOnly
            ? anyAnswered &&
              !entryDone && (
                <span className="shrink-0 text-xs text-quaternary">
                  {m.action_card_questions_unanswered()}
                </span>
              )
            : entry.select === "many" && (
                <span className="shrink-0 text-xs text-tertiary">
                  {m.action_card_questions_many()}
                </span>
              )}
        </div>
        <QuestionRows
          question={entry}
          draft={drafts[entry.id]}
          canAnswer
          disabled={disabled}
          readOnly={readOnly}
          onChange={onPick}
        />
      </>
    );
  };

  return (
    <div
      ref={card}
      data-keys-active={active ? "" : undefined}
      className="flex flex-col gap-3"
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setActiveQuestionsCard(self)}
      onPointerLeave={() => {
        if (!card.current?.contains(document.activeElement)) releaseQuestionsCard(self);
      }}
      onFocus={() => setActiveQuestionsCard(self)}
    >
      {/* Every question in one cell, only the current one shown: the card is as tall as its
          tallest question on every page, so turning them moves nothing below (Frank, 11-05,
          task #535). A shorter question sits at the top. On a touch screen a finger drags the next
          question in; at rest none of it shows (task #81: its cut-off edge read as spilled text,
          Frank 11-11), and the dots and arrows say there is more. */}
      <div
        ref={pages}
        {...swipe}
        className={cn(
          "grid touch-pan-y",
          // Clipped on a touch screen only: on a desktop the rows' focus rings reach past the edge.
          questions.length > 1 &&
            "pointer-coarse:grid-cols-[minmax(0,1fr)] pointer-coarse:overflow-x-clip",
        )}
      >
        {questions.map((entry, index) => {
          return index === step ? (
            <div
              ref={body}
              key={`current-${step}`}
              tabIndex={-1}
              data-question={question.id}
              className="flex flex-col gap-1.5 outline-none [grid-area:1/1]"
            >
              <div
                className={cn(
                  "flex flex-col gap-1.5",
                  !swiped && "animate-in motion-enter-sm fade-in motion-reduce:animate-none",
                  !swiped && (direction > 0 ? "slide-in-from-right-2" : "slide-in-from-left-2"),
                )}
              >
                {page(entry, pick)}
              </div>
            </div>
          ) : (
            <div
              key={entry.id}
              aria-hidden="true"
              inert
              data-question-peek={Math.abs(index - step) === 1 ? "" : undefined}
              // Beside the current page, a gap away, shown only while a finger brings it in
              // (`useQuestionSwipe` places it); at rest hidden where it lies.
              data-question-next={index === step + 1 ? "" : undefined}
              data-question-previous={index === step - 1 ? "" : undefined}
              className="invisible flex flex-col gap-1.5 [grid-area:1/1]"
            >
              {page(entry, () => undefined)}
            </div>
          );
        })}
      </div>
      {notice}
      {(!readOnly || questions.length > 1) && (
        <div className="flex items-center gap-2 px-2">
          {questions.length > 1 && (
            <ol aria-label={m.action_card_questions_steps()} className="-ml-1.5 flex items-center">
              {questions.map((entry, index) => (
                <li key={entry.id}>
                  <AriaButton
                    aria-label={m.action_card_questions_go_to({ number: index + 1 })}
                    aria-current={index === step ? "step" : undefined}
                    data-step-done={answered(drafts[entry.id]) ? "" : undefined}
                    onPress={() => goTo(index)}
                    // A dot to see, a wider target to press: wider again under a finger.
                    className="group/dot grid size-5 cursor-pointer place-items-center rounded-full outline-focus-ring data-focus-visible:outline-2 pointer-coarse:size-8"
                  >
                    {/* One look per state on every card (Raft, task #515), in grays (Frank:
                        no purple but the main button): the current question a longer dash,
                        answered dark, not yet answered light, skipped (on an answered card) a
                        ring. */}
                    <span
                      className={cn(
                        "h-1.5 rounded-full transition-[width,background-color]",
                        index === step ? "w-3.5" : "w-1.5",
                        answered(drafts[entry.id])
                          ? "bg-fg-secondary"
                          : readOnly && anyAnswered
                            ? "border border-fg-quaternary"
                            : index === step
                              ? "bg-fg-quaternary"
                              : "bg-quaternary group-hover/dot:bg-fg-quaternary",
                      )}
                    />
                  </AriaButton>
                </li>
              ))}
            </ol>
          )}
          {readOnly && (
            // The way through the pages as the keys that do it: ← →, keycaps like the rows' own
            // keys, clicked or pressed. On the one card the arrows turn they are filled; on any
            // other they wait, quieter.
            // Under a finger they are 32px keys spaced apart, each pressed anywhere in a 44px
            // square around it (task #560; Apple's minimum touch target, WCAG 2.5.5).
            <span className="ml-auto flex items-center gap-1 pointer-coarse:gap-3">
              {(
                [
                  ["←", "ArrowLeft", m.action_card_questions_previous_step(), step === 0, -1],
                  ["→", "ArrowRight", m.action_card_questions_next(), isLast, 1],
                ] as const
              ).map(([glyph, key, label, end, delta]) => (
                <AriaButton
                  key={key}
                  aria-label={label}
                  aria-keyshortcuts={key}
                  isDisabled={end}
                  onPress={() => goTo(step + delta)}
                  className={cn(
                    "relative grid size-6 cursor-pointer place-items-center rounded-md font-body text-xs font-medium outline-focus-ring transition-colors data-disabled:cursor-default data-disabled:opacity-40 data-focus-visible:outline-2 pointer-coarse:size-8 pointer-coarse:text-sm pointer-coarse:before:absolute pointer-coarse:before:-inset-1.5",
                    active
                      ? "bg-secondary text-tertiary data-hovered:bg-tertiary"
                      : "text-quaternary data-hovered:bg-secondary",
                  )}
                >
                  <span aria-hidden="true">{glyph}</span>
                </AriaButton>
              ))}
            </span>
          )}
          {!readOnly && (
            <span className="ml-auto flex items-center gap-2">
              {action}
              {step > 0 && (
                <Button size="sm" color="secondary" onPress={() => goTo(step - 1)}>
                  {m.action_card_questions_previous_step()}
                </Button>
              )}
              {isLast ? (
                <Button
                  size="sm"
                  color="primary"
                  isDisabled={!canSubmit}
                  isLoading={submitting}
                  showTextWhileLoading
                  onPress={onSubmit}
                >
                  {submitting
                    ? m.action_card_questions_submitting()
                    : m.action_card_questions_submit()}
                </Button>
              ) : done ? (
                <Button size="sm" color="primary" onPress={() => goTo(step + 1)}>
                  {m.action_card_questions_next()}
                </Button>
              ) : (
                <Button size="sm" color="secondary" onPress={() => goTo(step + 1)}>
                  {m.action_card_questions_skip()}
                </Button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Controls that use the arrows themselves: a key pressed in one is theirs, not a card's. */
const ARROW_OWNERS =
  '[role="menu"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="grid"], [role="treegrid"], [role="tree"], [role="dialog"]';
