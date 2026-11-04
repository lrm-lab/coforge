import { useState } from "react";
import { AlertCircle, CheckCircle, Clock, SlashCircle01 } from "@untitledui/icons";
import { CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { AnsweredAtTooltip } from "./action-card-answered-at";
import {
  answered,
  QuestionRows,
  type Draft,
  type Question,
  type QuestionsView,
} from "./action-card-question-rows";

/** One answer for every question, as `commitQuestionsActionCard` takes it. */
export type QuestionsAnswer = { questionId: string; selection: string[]; text?: string };

/** The drafts as the server takes them: the person's own words as `_other`, only when there are
 * some. */
export function questionsAnswers(questions: Question[], drafts: Record<string, Draft>) {
  return questions.map((question): QuestionsAnswer => {
    const draft = drafts[question.id] ?? { selection: [], text: "" };
    const text = draft.text.trim();
    const selection = draft.selection.filter((id) => id !== CHOICE_OTHER_OPTION_ID);
    return text
      ? { questionId: question.id, selection: [...selection, CHOICE_OTHER_OPTION_ID], text }
      : { questionId: question.id, selection };
  });
}

/** Whether every question has its answer, the only state in which the card can be sent. */
export function questionsComplete(questions: Question[], drafts: Record<string, Draft>) {
  return questions.every((question) => answered(drafts[question.id]));
}

/**
 * An Agent's several questions on one card (task #515, the server's `questions` card of #503): each
 * question with its options as rows, one pick or several, the Agent's recommendation marked, and
 * the person's own words as a last row when the Agent offers one. Nothing is sent until every
 * question has an answer; then one Submit sends them all. Anyone but the asked person sees the
 * questions and whom the card waits on. Handled, it stays a card: each question over its answer.
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
  const done = view.questions.filter((question) => answered(drafts[question.id])).length;
  const complete = done === view.questions.length;

  async function submit() {
    if (!complete || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(questionsAnswers(view.questions, drafts));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="group"
      aria-label={view.prompt || view.questions[0]?.prompt}
      data-questions-card=""
      className="mt-1 flex max-w-md flex-col gap-4 rounded-xl border border-secondary bg-primary px-1.5 pt-3 pb-1.5"
    >
      {view.prompt && (
        <p className="px-2.5 text-sm font-semibold wrap-anywhere text-primary">{view.prompt}</p>
      )}
      {view.questions.map((question, index) => (
        <section key={question.id} data-question={question.id} className="flex flex-col">
          <div className="flex items-baseline gap-2 px-2.5 pb-2 text-sm">
            {view.questions.length > 1 && (
              <span className="shrink-0 text-tertiary tabular-nums">{index + 1}.</span>
            )}
            <p className="min-w-0 flex-1 font-semibold wrap-anywhere text-primary">
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
          ) : (
            <QuestionOutcome view={view} question={question} />
          )}
        </section>
      ))}
      {pending && (error || canAnswer || waitingOn || withdrawable) && (
        <div className="flex flex-col gap-2 px-2.5 pb-1">
          {error && (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-error-primary">
              <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            {canAnswer && (
              <p className="min-w-0 flex-1 text-xs text-tertiary tabular-nums">
                {m.action_card_questions_progress({ answered: done, total: view.questions.length })}
              </p>
            )}
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
            {canAnswer && (
              <Button
                size="sm"
                color="primary"
                isDisabled={!complete}
                isLoading={submitting}
                showTextWhileLoading
                onPress={() => void submit()}
                className="ml-auto"
              >
                {submitting
                  ? m.action_card_questions_submitting()
                  : m.action_card_questions_submit()}
              </Button>
            )}
          </div>
        </div>
      )}
      {!pending && <ClosedReason view={view} />}
    </div>
  );
}

/** A handled question's answer behind a check: the options picked and the person's own words. */
function QuestionOutcome({ view, question }: { view: QuestionsView; question: Question }) {
  if (view.state !== "executed") return null;
  const answer = view.result?.answers.find((entry) => entry.questionId === question.id);
  const labels = answer?.selection.map((pick) => pick.text ?? pick.label) ?? [];
  const answeredBy = view.asked?.isViewer ? undefined : view.committedBy?.displayName;
  const line = labels.length ? (
    <span className="flex min-w-0 items-start gap-1.5 px-2.5 text-sm">
      <CheckCircle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-fg-success-secondary"
      />
      <span className="min-w-0 font-medium wrap-anywhere text-primary">{labels.join(", ")}</span>
    </span>
  ) : (
    <span className="px-2.5 text-sm text-quaternary">{m.action_card_questions_unanswered()}</span>
  );
  return view.committedAt ? (
    <AnsweredAtTooltip at={view.committedAt} by={answeredBy}>
      {line}
    </AnsweredAtTooltip>
  ) : (
    line
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
