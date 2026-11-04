import { Checkbox, CheckboxGroup, Radio, RadioGroup } from "react-aria-components";
import { CHOICE_OTHER_OPTION_ID, CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/**
 * The key a row is picked with, at the row's start, always in sight (Frank, 11-04, as Grok's
 * question card shows it): gray, filled with the text's own colour once the row is picked; no
 * purple on the card but its main button (Frank, 11-04).
 */
export function KeyBadge({ picked, children }: { picked?: boolean; children: React.ReactNode }) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md font-body text-xs font-medium tabular-nums transition-colors",
        picked ? "bg-fg-primary text-(--color-bg-primary)" : "bg-secondary text-tertiary",
      )}
    >
      {children}
    </kbd>
  );
}

/** A row on a card: no border, its key first, a tint under the pointer (Frank, 11-04). */
export const CARD_ROW =
  "flex min-h-9 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm text-primary outline-focus-ring hover:bg-primary_hover max-sm:min-h-11";

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
  readOnly,
  onChange,
}: {
  question: Question;
  draft?: Draft;
  canAnswer: boolean;
  disabled: boolean;
  /** Answered: the pick stays marked, the rest gray, nothing changes. */
  readOnly?: boolean;
  onChange: (draft: Draft) => void;
}) {
  if (!canAnswer)
    return (
      <ul className="flex flex-col">
        {question.options.map((option, index) => (
          <li
            key={option.id}
            className="flex items-center gap-3 px-2 py-1 text-sm wrap-anywhere text-secondary"
          >
            <KeyBadge>{index + 1}</KeyBadge>
            <span className="min-w-0 flex-1">{option.label}</span>
            {option.recommended && <Recommended />}
          </li>
        ))}
      </ul>
    );
  const many = question.select === "many";
  const selection = draft?.selection ?? [];
  const rows = question.options.map((option, index) => {
    const className = ({ isSelected }: { isSelected: boolean }) =>
      cn(
        CARD_ROW,
        "data-focus-visible:outline-2 data-focus-visible:-outline-offset-1 data-disabled:cursor-default",
        readOnly && "cursor-default hover:bg-transparent",
        // Answered, the rest go gray behind the pick; nothing picked yet, they read as asked.
        readOnly && !isSelected && answered(draft) && "text-quaternary",
      );
    const content = ({ isSelected }: { isSelected: boolean }) => (
      <>
        <KeyBadge picked={isSelected}>{index + 1}</KeyBadge>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="wrap-anywhere">{option.label}</span>
          {option.description && (
            <span className="text-xs wrap-anywhere text-tertiary">{option.description}</span>
          )}
        </span>
        {option.recommended && <Recommended />}
      </>
    );
    return many ? (
      <Checkbox
        key={option.id}
        value={option.id}
        data-question-option={option.id}
        aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
        className={className}
      >
        {content}
      </Checkbox>
    ) : (
      <Radio
        key={option.id}
        value={option.id}
        data-question-option={option.id}
        aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
        className={className}
      >
        {content}
      </Radio>
    );
  });
  return (
    <div className="flex flex-col">
      {many ? (
        <CheckboxGroup
          aria-label={question.prompt}
          value={selection}
          isDisabled={disabled}
          isReadOnly={readOnly}
          onChange={(value) => onChange({ selection: value, text: draft?.text ?? "" })}
          className="flex flex-col"
        >
          {rows}
        </CheckboxGroup>
      ) : (
        <RadioGroup
          aria-label={question.prompt}
          value={selection[0] ?? null}
          isDisabled={disabled}
          isReadOnly={readOnly}
          onChange={(value) => onChange({ selection: [value], text: "" })}
          className="flex flex-col"
        >
          {rows}
        </RadioGroup>
      )}
      {question.other &&
        (!readOnly || draft?.text.trim()) && (
          // The person's own words: one more keyed row, typed into where it stands.
          <label className={cn(CARD_ROW, "cursor-text focus-within:bg-primary_hover")}>
            <KeyBadge picked={Boolean(draft?.text.trim())}>{question.options.length + 1}</KeyBadge>
            <input
              data-question-other=""
              type="text"
              value={draft?.text ?? ""}
              aria-label={question.other.label || m.action_card_choice_other()}
              placeholder={question.other.label || m.action_card_choice_other()}
              maxLength={CHOICE_OTHER_TEXT_MAX_LENGTH}
              readOnly={disabled || readOnly}
              onChange={(event) => {
                const text = event.target.value;
                // A single-pick question's own words replace its ticked option.
                const selection =
                  question.select === "one" && text.trim() ? [] : (draft?.selection ?? []);
                onChange({ selection, text });
              }}
              className="min-w-0 flex-1 bg-transparent text-primary outline-none placeholder:text-placeholder"
            />
          </label>
        )}
    </div>
  );
}

function Recommended() {
  return (
    <span className="shrink-0 text-xs text-tertiary">{m.action_card_questions_recommended()}</span>
  );
}
