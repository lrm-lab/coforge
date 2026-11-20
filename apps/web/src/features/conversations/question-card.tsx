import { useEffect, useState } from "react";

import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useQuestionCards } from "./question-card-host";
import { cardQuestions, givenAnswers, isMine, type AskingView } from "./question-card-model";
import { QuestionAsk } from "./question-card-ask";
import { QuestionOptions } from "./question-card-options";
import { QuestionPager } from "./question-card-pager";
import { QuestionPageStack } from "./question-card-parts";
import { cardStatus } from "./question-card-status";
import { dropQuestionDrafts } from "./question-drafts";
import { AnswerSummary, UnansweredQuestions } from "./question-card-summary";
import { useSettleInPlace } from "./settle-in-place";

export function QuestionCard({ card, asker }: { card: AskingView; asker: string }) {
  const cards = useQuestionCards();
  const view = cards?.viewOf(card) ?? card;
  const [handledHere, setHandledHere] = useState(false);
  const [tab, setTab] = useState(0);
  const [kbd, setKbd] = useState(false);
  const { box, settles, heldHeight } = useSettleInPlace(view, handledHere);
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const pending = view.state === "pending";
  const answered = view.state === "executed";
  useEffect(() => {
    if (!pending) dropQuestionDrafts(view.messageId);
  }, [pending, view.messageId]);
  const questions = cardQuestions(view);
  const several = questions.length > 1;
  const time = (iso: string) => formatMonthDayTime(iso, timeZone, getLocale(), timeFormat);
  const status = cardStatus(view, { mine: isMine(view), time });

  let body;
  if (pending)
    body = (
      <QuestionAsk
        view={view}
        asker={asker}
        status={status}
        due={view.deadline ? m.question_card_due({ time: time(view.deadline) }) : undefined}
        tab={tab}
        setTab={setTab}
        kbd={kbd}
        setKbd={setKbd}
        onHandled={() => setHandledHere(true)}
        focusAfter={() => cards?.waitingKeysTarget(view.messageId) ?? box.current}
      />
    );
  else {
    const answers = answered ? givenAnswers(view) : {};
    const statusLine = status && (
      <span data-question-status="" className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        {status}
      </span>
    );
    if (settles) {
      const activeTab = Math.min(tab, questions.length - 1);
      const question = questions[activeTab]!;
      const mode = answered ? "answered" : "off";
      const promptClass = cn(
        "px-3 pt-2 pb-1.5 text-sm wrap-anywhere",
        several ? "font-medium" : "font-semibold",
        answered ? "text-primary" : "text-tertiary",
      );
      body = (
        <>
          <QuestionPageStack
            items={questions}
            activeIndex={activeTab}
            renderSizer={(each) => (
              <>
                <p className={promptClass}>{each.prompt}</p>
                <QuestionOptions id="" question={each} draft={answers[each.id]} mode={mode} sizer />
              </>
            )}
          >
            <p data-question-prompt="" className={promptClass}>
              {question.prompt}
            </p>
            <QuestionOptions
              key={question.id}
              id={`${view.messageId}-q${activeTab}`}
              question={question}
              draft={answers[question.id]}
              mode={mode}
            />
          </QuestionPageStack>
          <div className="mt-auto flex min-h-10 flex-wrap items-center gap-x-3 pt-1 pl-3 text-xs text-quaternary max-sm:min-h-13">
            {several && <QuestionPager tab={activeTab} total={questions.length} onTurn={setTab} />}
            {statusLine}
          </div>
        </>
      );
    } else
      body = (
        <>
          {answered ? (
            <AnswerSummary questions={questions} answers={answers} />
          ) : (
            <UnansweredQuestions questions={questions} />
          )}
          {statusLine && (
            <div className="flex min-h-10 items-center px-3 py-2 text-xs text-quaternary">
              {statusLine}
            </div>
          )}
        </>
      );
  }

  return (
    <div
      ref={box}
      style={heldHeight ? { minHeight: heldHeight } : undefined}
      data-question-card={view.state}
      data-question-card-view={pending || settles ? "full" : "compact"}
      data-message={view.messageId}
      data-question-at={pending && several ? tab : undefined}
      data-question-keys={pending && kbd ? "" : undefined}
      data-no-row-tap
      tabIndex={-1}
      className={cn(
        "mt-1 flex max-w-md flex-col rounded-xl border border-secondary bg-primary p-1 outline-none [overflow-anchor:none] max-sm:max-w-none",
        pending && "focus-within:border-primary",
      )}
    >
      {several && view.kind === "questions" && view.prompt && (
        <p
          data-question-title=""
          className="px-3 pt-2 text-sm font-semibold wrap-anywhere text-primary"
        >
          {view.prompt}
        </p>
      )}
      {body}
    </div>
  );
}
