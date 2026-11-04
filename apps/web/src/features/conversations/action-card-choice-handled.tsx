import { useLayoutEffect, useState } from "react";
import { CheckCircle, SlashCircle01 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";

import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AnsweredAtTooltip } from "./action-card-answered-at";

type ChoiceView = Extract<ActionCardView, { kind: "choice" }>;

/** The answer a handled card closed on: the option's label, or the person's own words. */
export function chosenAnswer(view: ChoiceView): string | undefined {
  if (view.state !== "executed" || !view.result) return undefined;
  if (view.result.optionId === CHOICE_OTHER_OPTION_ID) return view.result.text ?? view.result.label;
  return view.options.find((option) => option.id === view.result?.optionId)?.label;
}

/** What stands in for the answer on a card closed without one, in gray: withdrawn, run out, or
 * answered in the chat instead (task #453). */
function closedWithoutAnswer(view: ChoiceView): string | undefined {
  if (view.state === "cancelled") return m.action_card_cancelled();
  if (view.state === "expired") return m.action_card_expired();
  if (view.state === "answered_in_chat") return m.action_card_answered_in_chat();
  return undefined;
}

/**
 * The handled card: still a card, as Frank asked (11-04), so a question that was asked and answered
 * reads as one. The question on top, two lines at most (a press on a cut question shows the rest);
 * under it what was chosen, behind a check, or in gray why it closed without an answer. Someone
 * else's answer is followed by their name, cut when long; the answer's tooltip names them in full
 * and says when.
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
    <span
      ref={setQuestionEl}
      data-handled-question=""
      className={cn("block", !expanded && "line-clamp-2")}
    >
      {view.prompt}
    </span>
  );
  const outcome = (
    <span className="flex min-w-0 items-start gap-1.5">
      <CheckCircle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-fg-success-secondary"
      />
      <span className="min-w-0">
        <span className="font-medium text-primary">{answer}</span>
        {answeredBy && (
          <span className="ml-1.5 inline-block max-w-48 truncate align-bottom text-quaternary">
            · {answeredBy}
          </span>
        )}
      </span>
    </span>
  );
  const closedLine = closed && (
    <span className="flex items-center gap-1.5 text-quaternary">
      <SlashCircle01 aria-hidden="true" className="size-4 shrink-0" />
      {closed}
    </span>
  );
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 text-sm wrap-anywhere">
      <div className="font-semibold text-secondary">
        {cut && !expanded ? (
          <AriaButton
            // Named by the question itself; `aria-expanded` says there is more of it.
            aria-expanded={false}
            onPress={() => setExpanded(true)}
            className="block w-full cursor-pointer rounded-sm text-left outline-focus-ring hover:text-primary focus-visible:outline-2"
          >
            {question}
          </AriaButton>
        ) : (
          question
        )}
      </div>
      {answer === undefined ? (
        closedLine &&
        (view.committedAt ? (
          // Who closed it and when, as an answer's tooltip says (task #472).
          <AnsweredAtTooltip
            at={view.committedAt}
            by={view.committedBy?.isViewer ? undefined : view.committedBy?.displayName}
          >
            {closedLine}
          </AnsweredAtTooltip>
        ) : (
          closedLine
        ))
      ) : view.committedAt ? (
        <AnsweredAtTooltip at={view.committedAt} by={answeredBy}>
          {outcome}
        </AnsweredAtTooltip>
      ) : (
        outcome
      )}
    </div>
  );
}
