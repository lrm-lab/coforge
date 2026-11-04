import { useState } from "react";
import { AlertCircle, Clock, SlashCircle01 } from "@untitledui/icons";
import { CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  answered,
  QuestionRows,
  type Draft,
  type Question,
  type QuestionsView,
} from "./action-card-question-rows";
import { QuestionsStepper } from "./action-card-questions-stepper";

/** One question's answer, as `commitQuestionsActionCard` takes it. */
export type QuestionsAnswer = { questionId: string; selection: string[]; text?: string };

/** The drafts as the server takes them: the person's own words as `_other`, only when there are
 * some. A question left unanswered is left out; the server records it skipped. */
export function questionsAnswers(questions: Question[], drafts: Record<string, Draft>) {
  return questions.flatMap((question): QuestionsAnswer[] => {
    const draft = drafts[question.id];
    if (!answered(draft)) return [];
    const text = draft!.text.trim();
    const selection = draft!.selection.filter((id) => id !== CHOICE_OTHER_OPTION_ID);
    return [
      text
        ? { questionId: question.id, selection: [...selection, CHOICE_OTHER_OPTION_ID], text }
        : { questionId: question.id, selection },
    ];
  });
}

/**
 * An Agent's several questions on one card (task #515, the server's `questions` card of #503): each
 * question with its options as rows, one pick or several, the Agent's recommendation marked, and
 * the person's own words as a last row when the Agent offers one, one question at a time. A
 * question may be skipped; one Submit sends what was answered. Anyone but the asked person turns
 * the same pages with nothing to pick, over whom the card waits on. Answered, the pages stay, each
 * pick marked.
 */
export function QuestionsActionCard({
  view,
  error,
  cancelling,
  onSubmit,
  onCancel,
}: {
  view: QuestionsView;
  error: string;
  cancelling: boolean;
  /** Resolves once the answers are stored (or failed); the card then shows what the server says. */
  onSubmit: (answers: QuestionsAnswer[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [submitting, setSubmitting] = useState(false);
  const pending = view.state === "pending";
  const canAnswer = pending && view.canCommit;
  const waitingOn = pending && !canAnswer ? view.asked?.displayName : undefined;
  const withdrawable = pending && view.canCancel && !canAnswer;
  // Answered, the same pages as while answering, each pick marked (Frank, 11-04).
  const answeredView = view.state === "executed" ? recordedDrafts(view) : undefined;
  // Asked of someone else, the same pages to look through, nothing to pick (Frank, 11-04: a list
  // of every question with keys read as if it were the viewer's to answer).
  const pagesOnly = answeredView ?? (pending && !canAnswer ? NO_DRAFTS : undefined);
  // A question may go unanswered (Frank, 11-04); one answer at least makes it an answer.
  const canSubmit = view.questions.some((question) => answered(drafts[question.id]));

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(questionsAnswers(view.questions, drafts));
    } finally {
      setSubmitting(false);
    }
  }

  const errorLine = error && (
    <p role="alert" className="flex items-center gap-1.5 px-2 text-sm text-error-primary">
      <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
      {error}
    </p>
  );
  // Anyone but the asked person: whom it waits on, and Dismiss for whoever may withdraw it.
  const footer = pending && !canAnswer && (error || waitingOn || withdrawable) && (
    <div className="flex flex-col gap-2 px-2.5 pb-1">
      {errorLine}
      <div className="flex items-center gap-3">
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
    </div>
  );

  return (
    <div
      role="group"
      aria-label={view.prompt || view.questions[0]?.prompt}
      data-questions-card=""
      className={cn(
        "mt-1 flex max-w-md flex-col rounded-xl border border-secondary bg-primary px-1.5 pt-3 pb-1.5",
        canAnswer || pagesOnly ? "gap-2" : "gap-4",
      )}
    >
      {view.prompt && (
        // While it is being answered the question leads; the card's own title stays small.
        <p
          className={cn(
            "wrap-anywhere",
            canAnswer || pagesOnly
              ? "px-2 text-xs text-tertiary"
              : "px-2.5 text-sm font-semibold text-primary",
          )}
        >
          {view.prompt}
        </p>
      )}
      {pagesOnly && (
        <QuestionsStepper
          questions={view.questions}
          drafts={pagesOnly}
          disabled={false}
          canSubmit={false}
          submitting={false}
          onChange={() => undefined}
          onSubmit={() => undefined}
          readOnly
        />
      )}
      {!canAnswer &&
        !pagesOnly &&
        view.questions.map((question, index) => (
          <section key={question.id} data-question={question.id} className="flex flex-col">
            <div className="flex items-baseline gap-2 px-2.5 pb-2 text-sm">
              {pending && view.questions.length > 1 && (
                <span className="shrink-0 text-tertiary tabular-nums">{index + 1}.</span>
              )}
              {/* Handled, the question in gray over its answer, as a handled choice card reads. */}
              <p
                className={cn(
                  "min-w-0 flex-1 font-semibold wrap-anywhere",
                  pending ? "text-primary" : "text-secondary",
                )}
              >
                {question.prompt}
              </p>
              {canAnswer && question.select === "many" && (
                <span className="shrink-0 text-xs text-tertiary">
                  {m.action_card_questions_many()}
                </span>
              )}
            </div>
            {pending ? (
              <QuestionRows
                question={question}
                draft={drafts[question.id]}
                canAnswer={canAnswer}
                disabled={submitting}
                onChange={(draft) => setDrafts((all) => ({ ...all, [question.id]: draft }))}
              />
            ) : null}
          </section>
        ))}
      {canAnswer ? (
        <QuestionsStepper
          questions={view.questions}
          drafts={drafts}
          disabled={submitting}
          canSubmit={canSubmit}
          submitting={submitting}
          onChange={(questionId, draft) => setDrafts((all) => ({ ...all, [questionId]: draft }))}
          onSubmit={() => void submit()}
          notice={errorLine}
        />
      ) : (
        footer
      )}
      {!pending && <ClosedReason view={view} />}
    </div>
  );
}

/** Under a card closed without answers, why, in gray; under an answered one, who answered when
 * it was someone else. */
function ClosedReason({ view }: { view: QuestionsView }) {
  const reason =
    view.state === "cancelled"
      ? m.action_card_cancelled()
      : view.state === "expired"
        ? m.action_card_expired()
        : view.state === "answered_in_chat"
          ? m.action_card_answered_in_chat()
          : undefined;
  if (reason)
    return (
      <p className="flex items-center gap-1.5 px-2.5 pb-1 text-sm text-quaternary">
        <SlashCircle01 aria-hidden="true" className="size-4 shrink-0" />
        {reason}
      </p>
    );
  const by = view.asked?.isViewer ? undefined : view.committedBy?.displayName;
  return by ? <p className="truncate px-2.5 pb-1 text-xs text-quaternary">{by}</p> : null;
}

const NO_DRAFTS: Record<string, Draft> = {};

/** The stored answers as drafts, to show them on the pages they were given on. */
function recordedDrafts(view: QuestionsView): Record<string, Draft> {
  return Object.fromEntries(
    (view.result?.answers ?? []).map((answer) => [
      answer.questionId,
      {
        selection: answer.selection.map((pick) => pick.optionId),
        text: answer.selection.find((pick) => pick.optionId === CHOICE_OTHER_OPTION_ID)?.text ?? "",
      },
    ]),
  );
}
