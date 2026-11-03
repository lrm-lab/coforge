import { useLayoutEffect, useState, type CSSProperties } from "react";
import { Button as AriaButton } from "react-aria-components";
import { CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

type ChoiceView = Extract<ActionCardView, { kind: "choice" }>;

/** The question cut to two lines. An inline box: a question that fits on one line keeps the answer
 * beside it, a longer one takes the column's width and the answer starts below it. */
const TWO_LINES: CSSProperties = {
  display: "-webkit-inline-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
};

/** The answer a handled card closed on: the option's label, or the person's own words. */
export function chosenAnswer(view: ChoiceView): string | undefined {
  if (view.state !== "executed" || !view.result) return undefined;
  if (view.result.optionId === CHOICE_OTHER_OPTION_ID) return view.result.text ?? view.result.label;
  return view.options.find((option) => option.id === view.result?.optionId)?.label;
}

/** What stands in for the answer on a card closed without one, in gray. A card that expires or is
 * answered in the chat instead is written here too once the server records those states. */
function closedWithoutAnswer(view: ChoiceView): string | undefined {
  if (view.state === "cancelled") return m.action_card_cancelled();
  return undefined;
}

/**
 * The handled card's one line: the question in gray, then what was chosen. The question shows two
 * lines at most, so a run of handled cards reads as answers, not as questions (Raft, #449); a
 * press on a cut question shows the rest. The answer is always whole. Someone else's answer is
 * followed by their name, cut when long; the answer's tooltip names them in full and says when.
 */
export function HandledChoice({ view, answer }: { view: ChoiceView; answer?: string }) {
  const closed = closedWithoutAnswer(view);
  const answeredBy = view.asked?.isViewer ? undefined : view.committedBy?.displayName;
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  // The question's element, as state: it moves into a button once cut, and the measuring follows.
  const [questionEl, setQuestionEl] = useState<HTMLSpanElement | null>(null);
  // Whether the two lines cut the question, measured again as the column's width changes.
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
    <span ref={setQuestionEl} style={expanded ? undefined : TWO_LINES}>
      {view.prompt}
    </span>
  );
  const outcome = (
    <>
      <span className="font-medium text-primary">{answer}</span>
      {answeredBy && (
        <span className="ml-1.5 inline-block max-w-48 truncate align-bottom text-quaternary">
          · {answeredBy}
        </span>
      )}
    </>
  );
  return (
    <p className="text-sm wrap-anywhere text-tertiary">
      {/* The gap trails the question, so a wrapped answer starts flush on its own line. */}
      {cut && !expanded ? (
        <AriaButton
          // Named by the question itself; `aria-expanded` says there is more of it.
          aria-expanded={false}
          onPress={() => setExpanded(true)}
          className="mr-1 cursor-pointer rounded-sm text-left align-bottom outline-focus-ring hover:text-secondary focus-visible:outline-2"
        >
          {question}
        </AriaButton>
      ) : (
        <span className="mr-1">{question}</span>
      )}{" "}
      {answer === undefined ? (
        closed && <span className="text-quaternary">{closed}</span>
      ) : view.committedAt ? (
        <Tooltip
          title={
            <>
              {answeredBy && <>{answeredBy} · </>}
              <AnsweredAt value={view.committedAt} />
            </>
          }
        >
          <TooltipTrigger
            // A button never lays out inline, and the trigger's own `w-max` would hold a long
            // answer on one line past the column: at the column's width it wraps instead.
            className="h-auto w-auto cursor-default rounded-sm text-left outline-focus-ring focus-visible:outline-2"
          >
            {outcome}
          </TooltipTrigger>
        </Tooltip>
      ) : (
        outcome
      )}
    </p>
  );
}

/** When a card was answered, written only while its tooltip is open. */
function AnsweredAt({ value }: { value: string }) {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  return formatMonthDayTime(value, timeZone, getLocale(), timeFormat);
}
