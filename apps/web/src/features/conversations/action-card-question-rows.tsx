import { Check, Pencil01 } from "@untitledui/icons";
import { Checkbox, CheckboxGroup, Radio, RadioGroup } from "react-aria-components";
import { CHOICE_OTHER_OPTION_ID, CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import { Badge } from "#src/components/base/badges/badges";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export type QuestionsView = Extract<ActionCardView, { kind: "questions" }>;
export type Question = QuestionsView["questions"][number];

/** One question's answer as it is being picked: the options ticked, and the person's own words. */
export type Draft = { selection: string[]; text: string };

/** Whether a question's draft answers it: an option ticked, or words of the person's own. */
export function answered(draft: Draft | undefined) {
  if (!draft) return false;
  const others = draft.selection.filter((id) => id !== CHOICE_OTHER_OPTION_ID);
  return others.length > 0 || draft.text.trim().length > 0;
}

/** A waiting question's options: rows to tick for the asked person, a plain list for anyone else. */
export function QuestionRows({
  question,
  draft,
  canAnswer,
  disabled,
  onChange,
}: {
  question: Question;
  draft?: Draft;
  canAnswer: boolean;
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) {
  if (!canAnswer)
    return (
      <ul className="flex flex-col">
        {question.options.map((option) => (
          <li
            key={option.id}
            className="flex items-baseline gap-2.5 px-2.5 py-1 text-sm wrap-anywhere text-secondary"
          >
            <span
              aria-hidden="true"
              className="size-1 shrink-0 -translate-y-[0.3em] rounded-full bg-current text-fg-quaternary"
            />
            {option.label}
            {option.recommended && <RecommendedBadge />}
          </li>
        ))}
      </ul>
    );
  const many = question.select === "many";
  const selection = draft?.selection ?? [];
  const rows = question.options.map((option) => {
    const className = ({ isSelected }: { isSelected: boolean }) =>
      cn(
        "flex min-h-10 w-full cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm text-primary outline-focus-ring max-sm:min-h-11",
        "hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-1 disabled:cursor-default",
        isSelected
          ? "border-brand bg-brand-primary_alt hover:bg-brand-primary_alt"
          : "border-secondary",
      );
    const content = ({ isSelected }: { isSelected: boolean }) => (
      <>
        <Tick ticked={isSelected} many={many} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5 wrap-anywhere">
            {option.label}
            {option.recommended && <RecommendedBadge />}
          </span>
          {option.description && (
            <span className="text-xs wrap-anywhere text-tertiary">{option.description}</span>
          )}
        </span>
      </>
    );
    return many ? (
      <Checkbox
        key={option.id}
        value={option.id}
        data-question-option={option.id}
        className={className}
      >
        {content}
      </Checkbox>
    ) : (
      <Radio
        key={option.id}
        value={option.id}
        data-question-option={option.id}
        className={className}
      >
        {content}
      </Radio>
    );
  });
  return (
    <div className="flex flex-col gap-1.5">
      {many ? (
        <CheckboxGroup
          aria-label={question.prompt}
          value={selection}
          isDisabled={disabled}
          onChange={(value) => onChange({ selection: value, text: draft?.text ?? "" })}
          className="flex flex-col gap-1.5"
        >
          {rows}
        </CheckboxGroup>
      ) : (
        <RadioGroup
          aria-label={question.prompt}
          value={selection[0] ?? null}
          isDisabled={disabled}
          onChange={(value) => onChange({ selection: [value], text: "" })}
          className="flex flex-col gap-1.5"
        >
          {rows}
        </RadioGroup>
      )}
      {question.other && (
        <label
          className={cn(
            "group/other flex min-h-10 w-full cursor-text items-center gap-2.5 rounded-lg bg-secondary px-2.5 text-sm max-sm:min-h-11",
            "focus-within:bg-primary focus-within:ring-1 focus-within:ring-brand focus-within:ring-inset",
            draft?.text.trim() && "bg-primary ring-1 ring-brand ring-inset",
          )}
        >
          <Pencil01
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-quaternary group-focus-within/other:text-fg-brand-primary"
          />
          <input
            data-question-other=""
            type="text"
            value={draft?.text ?? ""}
            aria-label={question.other.label || m.action_card_choice_other()}
            placeholder={question.other.label || m.action_card_choice_other()}
            maxLength={CHOICE_OTHER_TEXT_MAX_LENGTH}
            readOnly={disabled}
            onChange={(event) => {
              const text = event.target.value;
              // A single-pick question's own words replace its ticked option.
              const selection =
                question.select === "one" && text.trim() ? [] : (draft?.selection ?? []);
              onChange({ selection, text });
            }}
            className="min-w-0 flex-1 bg-transparent py-2 text-primary outline-none placeholder:text-placeholder"
          />
        </label>
      )}
    </div>
  );
}

/** A row's mark: a ring that fills for one pick, a box that ticks for several. */
function Tick({ ticked, many }: { ticked: boolean; many: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 grid size-4 shrink-0 place-items-center border",
        many ? "rounded-[4px]" : "rounded-full",
        ticked ? "border-brand-solid bg-brand-solid text-white" : "border-primary bg-primary",
      )}
    >
      {ticked &&
        (many ? (
          <Check className="size-3" strokeWidth={3} />
        ) : (
          <span className="size-1.5 rounded-full bg-white" />
        ))}
    </span>
  );
}

function RecommendedBadge() {
  return (
    <Badge type="pill-color" color="brand" size="sm">
      {m.action_card_questions_recommended()}
    </Badge>
  );
}
