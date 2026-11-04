import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { answered, QuestionRows, type Draft, type Question } from "./action-card-question-rows";
import { moveStep, swipeDelta } from "./action-card-questions-steps";

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
  /** Answered (Frank, 11-04): the same pages, each pick marked; only the dots and ← → remain. */
  readOnly?: boolean;
}) {
  const last = questions.length - 1;
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number }>(undefined);
  const autoNext = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(autoNext.current), []);
  // A question turned from inside the card keeps focus in it: the row pressed went with its step.
  const focusFollows = useRef(false);
  useEffect(() => {
    if (!focusFollows.current) return;
    focusFollows.current = false;
    body.current?.focus({ preventScroll: true });
  }, [step]);

  const goTo = (next: number) => {
    clearTimeout(autoNext.current);
    const clamped = moveStep(next, 0, last);
    if (clamped === step) return;
    setDirection(clamped > step ? 1 : -1);
    focusFollows.current = Boolean(card.current?.contains(document.activeElement));
    setStep(clamped);
  };
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
  const onTouchStart = (event: TouchEvent) => {
    const point = event.touches[0];
    touch.current = point && { x: point.clientX, y: point.clientY };
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    const point = event.changedTouches[0];
    touch.current = undefined;
    if (!start || !point) return;
    const delta = swipeDelta(point.clientX - start.x, point.clientY - start.y);
    if (delta) goTo(step + delta);
  };

  return (
    <div
      ref={card}
      className="flex flex-col gap-3"
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
    >
      <div
        ref={body}
        key={step}
        tabIndex={-1}
        data-question={question.id}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className={cn(
          "flex flex-col gap-1.5 outline-none animate-in duration-150 fade-in motion-reduce:animate-none",
          direction > 0 ? "slide-in-from-right-2" : "slide-in-from-left-2",
        )}
      >
        <div className="flex items-baseline gap-2 px-2 text-sm">
          <p className="min-w-0 flex-1 font-semibold wrap-anywhere text-primary">
            {question.prompt}
          </p>
          {readOnly
            ? anyAnswered &&
              !done && (
                <span className="shrink-0 text-xs text-quaternary">
                  {m.action_card_questions_unanswered()}
                </span>
              )
            : question.select === "many" && (
                <span className="shrink-0 text-xs text-tertiary">
                  {m.action_card_questions_many()}
                </span>
              )}
        </div>
        <QuestionRows
          question={question}
          draft={drafts[question.id]}
          canAnswer
          disabled={disabled}
          readOnly={readOnly}
          onChange={pick}
        />
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
                    // A dot to see, a wider target to press.
                    className="group/dot grid size-5 cursor-pointer place-items-center rounded-full outline-focus-ring data-focus-visible:outline-2"
                  >
                    {/* One look per state on every card (Raft, task #515): the current question
                        a longer dash, answered brand, not yet answered gray, skipped (on an
                        answered card) a ring. */}
                    <span
                      className={cn(
                        "h-1.5 rounded-full transition-[width,background-color]",
                        index === step ? "w-3.5" : "w-1.5",
                        answered(drafts[entry.id])
                          ? "bg-fg-brand-primary"
                          : readOnly && anyAnswered
                            ? "border border-fg-quaternary"
                            : index === step
                              ? "bg-fg-tertiary"
                              : "bg-quaternary group-hover/dot:bg-fg-quaternary",
                      )}
                    />
                  </AriaButton>
                </li>
              ))}
            </ol>
          )}
          {!readOnly && (
            <span className="ml-auto flex items-center gap-2">
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
