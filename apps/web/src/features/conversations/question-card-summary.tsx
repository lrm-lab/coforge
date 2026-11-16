import { m } from "#src/paraglide/messages";
import { answerText, type CardQuestion, type Drafts } from "./question-card-model";

export function AnswerSummary({
  questions,
  answers,
  showPrompt = true,
}: {
  questions: CardQuestion[];
  answers: Drafts;
  showPrompt?: boolean;
}) {
  return (
    <div data-question-summary="" className="flex flex-col gap-2.5 px-3 pt-1 pb-1">
      {questions.map((question) => {
        const words = answerText(question, answers[question.id]);
        return (
          <div
            key={question.id}
            data-question-answer={question.id}
            className="flex flex-col text-sm"
          >
            {showPrompt && <p className="text-xs wrap-anywhere text-tertiary">{question.prompt}</p>}
            <p
              className={
                words.length ? "font-medium wrap-anywhere text-primary" : "text-quaternary"
              }
            >
              {words.join(m.question_card_answer_separator()) || m.question_card_skipped()}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function UnansweredQuestions({ questions }: { questions: CardQuestion[] }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-1 pb-1">
      {questions.map((question) => (
        <p
          key={question.id}
          data-question-prompt=""
          className="text-sm wrap-anywhere text-quaternary"
        >
          {question.prompt}
        </p>
      ))}
    </div>
  );
}
