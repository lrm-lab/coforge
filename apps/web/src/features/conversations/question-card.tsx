import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useCardDock, useQuestionDrafts } from "./question-dock-host";
import {
  answerText,
  dockQuestions,
  givenAnswers,
  isMine,
  type AskingView,
} from "./question-dock-model";
import { cardStatus } from "./question-card-status";
import { useSettleInPlace } from "./settle-in-place";

/**
 * An Agent's question card in the stream (Frank, 11-12): a summary, each question on a line with
 * its answer beside it, answered in the pane's dock, which a row or Answer opens at that question; anyone else's card opens there to look through.
 *
 * The card shows where it stands rather than saying it (Frank, 11-12): an answer stands beside
 * its question, given in dark and still a draft in gray, and a card nobody will answer goes gray
 * whole. Its last line holds the next step (`cardStatus`). The card open in the dock is drawn
 * raised.
 */
export function QuestionCard({ card }: { card: AskingView }) {
  const dock = useCardDock();
  const view = dock?.viewOf(card) ?? card;
  const [drafts] = useQuestionDrafts(view);
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const pending = view.state === "pending";
  const answered = view.state === "executed";
  const off = !pending && !answered;
  const mine = isMine(view);
  const inDock = dock?.openId === view.messageId;
  const openable = Boolean(dock) && pending;
  const questions = dockQuestions(view);
  const shown = answered ? givenAnswers(view) : pending ? drafts : {};
  const status = cardStatus(view, { mine });
  const due =
    pending && view.deadline
      ? m.question_card_due({
          time: formatMonthDayTime(view.deadline, timeZone, getLocale(), timeFormat),
        })
      : undefined;
  const answerable = openable && mine;
  const { box, heldHeight } = useSettleInPlace(view);
  return (
    <div
      ref={box}
      style={heldHeight ? { minHeight: heldHeight } : undefined}
      data-question-card={view.state}
      // A tap on the card is the card's: its rows open the dock, and its gaps do nothing rather
      // than open the message's actions.
      data-no-row-tap
      className={cn(
        "mt-1 flex max-w-md flex-col rounded-xl border bg-primary p-1 transition-[border-color,box-shadow] duration-150 max-sm:max-w-none",
        inDock ? "border-primary ring-3 ring-secondary" : "border-secondary",
      )}
    >
      {questions.map((question, index) => {
        const text = off
          ? ""
          : answerText(question, shown[question.id]).join(m.question_card_answer_separator());
        const skipped = answered && !text;
        return (
          <AriaButton
            key={question.id}
            data-question-row={question.id}
            isDisabled={!openable}
            aria-label={text ? `${question.prompt}: ${text}` : question.prompt}
            onPress={() => dock?.open(view.messageId, index)}
            className="flex h-7 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-sm outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span
              className={cn("min-w-0 flex-1 truncate", off ? "text-quaternary" : "text-secondary")}
            >
              {question.prompt}
            </span>
            {(text || skipped) && (
              <span
                className={cn(
                  "max-w-[45%] min-w-0 shrink truncate",
                  skipped
                    ? "text-quaternary"
                    : pending
                      ? "text-tertiary"
                      : "font-medium text-primary",
                )}
              >
                {text || m.question_card_skipped()}
              </span>
            )}
          </AriaButton>
        );
      })}
      {/* One line after the questions, where the card's next step stands: the viewer's Answer
          (kept, unseen, while the card is in the dock, so opening it moves nothing), or whom it
          waits on, who answered, or why it went gray. */}
      {(answerable || status) && (
        <div className="flex h-9 items-center gap-2 pr-1 pl-3 text-xs text-tertiary">
          <span className="min-w-0 flex-1 truncate">
            {answerable ? due : status}
            {!answerable && due && ` · ${due}`}
          </span>
          {answerable && (
            <Button
              data-question-card-answer=""
              size="sm"
              color="secondary"
              className={cn(inDock && "invisible")}
              onPress={() => dock!.open(view.messageId)}
            >
              {m.question_card_answer()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
