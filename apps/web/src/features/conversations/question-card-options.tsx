import { CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { CardQuestion, Draft } from "./question-card-model";
import { Key, Mark, OPTION_ROW, OPTION_ROW_LIVE } from "./question-card-parts";

type OptionsMode = "live" | "view" | "answered" | "off";

export function QuestionOptions({
  id,
  question,
  draft,
  mode,
  hi = -1,
  kbd = false,
  otherRef,
  onHover,
  onPick,
  onDraft,
}: {
  id: string;
  question: CardQuestion;
  draft: Draft | undefined;
  mode: OptionsMode;
  hi?: number;
  kbd?: boolean;
  otherRef?: (element: HTMLInputElement | null) => void;
  onHover?: (row: number) => void;
  onPick?: (row: number) => void;
  onDraft?: (draft: Draft) => void;
}) {
  const many = question.select === "many";
  const live = mode === "live";
  const listed = live || mode === "view";
  const otherRow = question.options.length;
  const ownWords = draft?.text.trim() ?? "";
  const lit = (row: number) => live && kbd && row === hi && "pointer-fine:bg-secondary";
  const muted = mode === "off" || mode === "view";
  return (
    <div
      data-question-options={listed ? "" : undefined}
      role="listbox"
      tabIndex={listed ? 0 : undefined}
      aria-label={question.prompt}
      aria-multiselectable={many || undefined}
      aria-readonly={!live || undefined}
      aria-activedescendant={live && kbd && hi >= 0 ? `${id}-${hi}` : undefined}
      className="flex flex-col px-1 outline-none"
    >
      {question.options.map((option, row) => {
        const on = Boolean(draft?.selection.includes(option.id));
        const chosen = mode === "answered" && on;
        return (
          <div
            key={option.id}
            id={`${id}-${row}`}
            role="option"
            aria-selected={on}
            aria-keyshortcuts={live && row < 9 ? String(row + 1) : undefined}
            data-question-option={option.id}
            data-chosen={chosen ? "" : undefined}
            data-hi={live && kbd && row === hi ? "" : undefined}
            onMouseMove={() => live && row !== hi && onHover?.(row)}
            onClick={() => live && onPick?.(row)}
            className={cn("group/row", OPTION_ROW, live && OPTION_ROW_LIVE, lit(row))}
          >
            <Mark on={on} many={many} dim={mode === "off"} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cn(
                  "wrap-anywhere",
                  chosen
                    ? "font-medium text-primary"
                    : mode === "answered" || mode === "off"
                      ? "text-quaternary"
                      : muted
                        ? "text-secondary"
                        : "text-primary",
                )}
              >
                {option.label}
                {option.recommended && mode !== "answered" && (
                  <span className="ml-1.5 text-xs text-quaternary">
                    {m.action_card_questions_recommended()}
                  </span>
                )}
              </span>
              {option.description && listed && (
                <span className="text-xs wrap-anywhere text-tertiary">{option.description}</span>
              )}
            </span>
            {live && row < 9 && (
              <Key
                className={cn(
                  "ml-auto shrink-0 self-center pointer-coarse:hidden",
                  kbd && row === hi ? "visible" : "invisible group-hover/row:visible",
                )}
              >
                {row + 1}
              </Key>
            )}
          </div>
        );
      })}
      {question.other &&
        (live || mode === "view" || ownWords) &&
        (live ? (
          <div
            id={`${id}-${otherRow}`}
            role="option"
            aria-selected={Boolean(ownWords)}
            data-question-other=""
            data-hi={kbd && hi === otherRow ? "" : undefined}
            onMouseMove={() => hi !== otherRow && onHover?.(otherRow)}
            onClick={(event) => event.currentTarget.querySelector("input")?.focus()}
            className={cn(OPTION_ROW, "cursor-text", lit(otherRow))}
          >
            <Mark on={Boolean(ownWords)} many={many} />
            <input
              ref={otherRef}
              data-question-other-input=""
              type="text"
              value={draft?.text ?? ""}
              maxLength={CHOICE_OTHER_TEXT_MAX_LENGTH}
              aria-label={question.other.label || m.question_card_own_words()}
              placeholder={question.other.label || m.question_card_own_words()}
              onFocus={() => onHover?.(otherRow)}
              onChange={(event) => {
                const text = event.target.value;
                onDraft?.({
                  selection: many || !text.trim() ? (draft?.selection ?? []) : [],
                  text,
                });
              }}
              className="h-5 min-w-0 flex-1 bg-transparent text-primary outline-none placeholder:text-placeholder pointer-coarse:text-base"
            />
          </div>
        ) : (
          <div
            role="option"
            aria-selected={Boolean(ownWords)}
            data-question-other=""
            data-chosen={mode === "answered" && ownWords ? "" : undefined}
            className={OPTION_ROW}
          >
            <Mark on={Boolean(ownWords)} many={many} dim={mode === "off"} />
            <span
              className={cn(
                "min-w-0 flex-1 wrap-anywhere",
                mode === "answered" && ownWords ? "font-medium text-primary" : "text-quaternary",
              )}
            >
              {ownWords || question.other.label || m.question_card_own_words()}
            </span>
          </div>
        ))}
    </div>
  );
}
