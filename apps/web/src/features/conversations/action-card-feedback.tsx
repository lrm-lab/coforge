import type { Dispatch, FC, SetStateAction } from "react";
import { AlertCircle, Lightbulb02, MessageTextSquare01 } from "@untitledui/icons";
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  TextField as AriaTextField,
} from "react-aria-components";
import {
  FEEDBACK_SUBMIT_BODY_MAX_LENGTH,
  type FeedbackSubmitCategory,
} from "@lrm/coforge-sdk/agent";

import { TextAreaBase } from "#src/components/base/textarea/textarea";
import { m } from "#src/paraglide/messages";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cx } from "#src/utils/cx";

export type FeedbackCardDraft = {
  category: FeedbackSubmitCategory;
  body: string;
};

const CATEGORY_OPTIONS: readonly {
  id: FeedbackSubmitCategory;
  label: () => string;
  icon: FC<{ className?: string }>;
}[] = [
  { id: "bug", label: m.action_card_feedback_category_bug, icon: AlertCircle },
  { id: "idea", label: m.action_card_feedback_category_idea, icon: Lightbulb02 },
  { id: "other", label: m.action_card_feedback_category_other, icon: MessageTextSquare01 },
];

export function feedbackCategoryLabel(category: FeedbackSubmitCategory): string {
  switch (category) {
    case "bug":
      return m.action_card_feedback_category_bug();
    case "idea":
      return m.action_card_feedback_category_idea();
    case "other":
      return m.action_card_feedback_category_other();
  }
}

export function ActionCardFeedbackBody({
  view,
  draft,
  setDraft,
  disabled,
}: {
  view: Extract<ActionCardView, { kind: "feedback:submit" }>;
  draft?: FeedbackCardDraft;
  setDraft?: Dispatch<SetStateAction<FeedbackCardDraft>>;
  disabled?: boolean;
}) {
  const activeCategory = draft?.category ?? view.result?.category ?? view.category;
  const activeBody = draft?.body ?? view.result?.body ?? view.body;
  const editable = view.state === "pending" && view.canCommit && Boolean(setDraft);

  if (!editable) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex w-fit items-center rounded-full border border-primary px-2 py-0.5 text-xs font-medium text-secondary">
          {feedbackCategoryLabel(activeCategory)}
        </span>
        <p className="whitespace-pre-line wrap-anywhere text-primary">{activeBody}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <AriaRadioGroup
        aria-label={m.action_card_feedback_category_label()}
        orientation="horizontal"
        value={activeCategory}
        isDisabled={disabled}
        onChange={(value) =>
          setDraft?.((current) => ({ ...current, category: value as FeedbackSubmitCategory }))
        }
        className="flex flex-wrap gap-1.5"
      >
        {CATEGORY_OPTIONS.map((option) => {
          const Icon = option.icon;
          return (
            <AriaRadio
              key={option.id}
              value={option.id}
              className={({ isSelected, isFocusVisible }) =>
                cx(
                  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors duration-100 ease-out outline-focus-ring max-sm:min-h-9",
                  isSelected
                    ? "bg-selection-bar-primary text-selection-bar-primary-fg ring-transparent"
                    : "bg-primary text-secondary ring-secondary hover:bg-tertiary",
                  isFocusVisible && "outline-2 outline-offset-2",
                )
              }
            >
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span>{option.label()}</span>
            </AriaRadio>
          );
        })}
      </AriaRadioGroup>

      <div className="grid gap-1.5 rounded-lg border border-secondary bg-primary p-2.5 transition-colors duration-100 ease-out focus-within:border-field-border-typing">
        <AriaTextField
          aria-label={m.action_card_feedback_body_label()}
          value={activeBody}
          onChange={(next) => setDraft?.((current) => ({ ...current, body: next }))}
          isDisabled={disabled}
          maxLength={FEEDBACK_SUBMIT_BODY_MAX_LENGTH}
        >
          <TextAreaBase
            rows={3}
            placeholder={m.action_card_feedback_body_placeholder()}
            className="resize-none border-0 bg-transparent p-0 text-sm shadow-none ring-0 focus:ring-0"
          />
        </AriaTextField>
        <div className="flex items-center justify-between gap-2 text-xs text-tertiary">
          <span className="min-w-0 truncate">{m.action_card_feedback_note()}</span>
          <span className="shrink-0 text-quaternary tabular-nums">
            {activeBody.length} / {FEEDBACK_SUBMIT_BODY_MAX_LENGTH}
          </span>
        </div>
      </div>
    </div>
  );
}
