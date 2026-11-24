import type { Ref } from "react";
import { CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { CardQuestion, Draft } from "./question-card-model";
import { Keycap } from "#src/components/ui/kbd";
import { Mark, OPTION_ROW, OPTION_ROW_LIVE } from "./question-card-parts";

type OptionsMode = "live" | "view" | "answered" | "off";

export function QuestionOptions({
  id,
  question,
  draft,
  mode,
  hi = -1,
  kbd = false,
  otherRef,
  otherEnterKeyHint = "send",
  onHover,
  onPick,
  onDraft,
  onListFocus,
  onListBlur,
  sizer = false,
}: {
  id: string;
  question: CardQuestion;
  draft: Draft | undefined;
  mode: OptionsMode;
  hi?: number;
  kbd?: boolean;
  otherRef?: Ref<HTMLInputElement>;
  otherEnterKeyHint?: "next" | "send";
  onHover?: (row: number) => void;
  onPick?: (row: number) => void;
  onDraft?: (draft: Draft) => void;
  onListFocus?: (fromOtherInput: boolean) => void;
  onListBlur?: () => void;
  sizer?: boolean;
}) {
  const many = question.select === "many";
  const interactiveMode = mode === "live";
  const live = !sizer && interactiveMode;
  const listed = !sizer && (interactiveMode || mode === "view");
  const otherRow = question.options.length;
  const ownWords = draft?.text.trim() ?? "";
  const lit = (row: number) =>
    live && kbd && row === hi && "border-primary bg-secondary ring-2 ring-focus-ring ring-inset";
  const muted = mode === "off" || mode === "view";
  return (
    <div
      data-question-options={listed ? "" : undefined}
      role={sizer ? undefined : "listbox"}
      tabIndex={listed ? 0 : undefined}
      aria-label={sizer ? undefined : question.prompt}
      aria-multiselectable={sizer ? undefined : many || undefined}
      aria-readonly={sizer ? undefined : !live || undefined}
      aria-activedescendant={live && kbd && hi >= 0 ? `${id}-${hi}` : undefined}
      onFocus={
        listed
          ? (event) => {
              if (event.target !== event.currentTarget) return;
              const fromOther =
                event.relatedTarget instanceof Element &&
                event.relatedTarget.hasAttribute("data-question-other-input");
              onListFocus?.(fromOther);
            }
          : undefined
      }
      onBlur={
        listed
          ? (event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              )
                return;
              onListBlur?.();
            }
          : undefined
      }
      onMouseDown={
        listed
          ? (event) => {
              if (
                event.button !== 0 ||
                (event.target instanceof Element &&
                  event.target.closest("input, textarea, button, a"))
              )
                return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
            }
          : undefined
      }
      className={cn(
        "flex flex-col gap-1.5 rounded-lg px-1 outline-none",
        listed &&
          !kbd &&
          "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset",
      )}
    >
      {question.options.map((option, row) => {
        const on = Boolean(draft?.selection.includes(option.id));
        const chosen = mode === "answered" && on;
        return (
          <div
            key={option.id}
            id={sizer ? undefined : `${id}-${row}`}
            role={sizer ? undefined : "option"}
            aria-selected={sizer ? undefined : on}
            aria-keyshortcuts={live && row < 9 ? String(row + 1) : undefined}
            data-question-option={sizer ? undefined : option.id}
            data-chosen={!sizer && chosen ? "" : undefined}
            data-hi={live && kbd && row === hi ? "" : undefined}
            onPointerMove={
              live
                ? (event) => event.pointerType === "mouse" && row !== hi && onHover?.(row)
                : undefined
            }
            onClick={live ? () => onPick?.(row) : undefined}
            className={cn("group/row", OPTION_ROW, interactiveMode && OPTION_ROW_LIVE, lit(row))}
          >
            <Mark on={on} many={many} dim={muted} />
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
              {option.description && (
                <span
                  className={cn(
                    "text-xs wrap-anywhere",
                    interactiveMode || mode === "view" ? "text-tertiary" : "text-quaternary",
                  )}
                >
                  {option.description}
                </span>
              )}
            </span>
            {interactiveMode && row < 9 && (
              <Keycap
                size="xs"
                className={cn(
                  "ml-auto self-center any-pointer-coarse:hidden",
                  live && kbd && row === hi ? "visible" : "invisible group-hover/row:visible",
                )}
              >
                {row + 1}
              </Keycap>
            )}
          </div>
        );
      })}
      {question.other &&
        (interactiveMode || mode === "view" || ownWords) &&
        (live ? (
          <div
            id={`${id}-${otherRow}`}
            role="option"
            aria-selected={Boolean(ownWords)}
            data-question-other=""
            data-hi={kbd && hi === otherRow ? "" : undefined}
            onPointerMove={(event) =>
              event.pointerType === "mouse" && hi !== otherRow && onHover?.(otherRow)
            }
            onClick={(event) => {
              const input = event.currentTarget.querySelector("input");
              if (input && event.target !== input) input.focus();
            }}
            className={cn(
              OPTION_ROW,
              "cursor-text border-secondary pointer-fine:hover:border-primary focus-within:border-primary focus-within:ring-2 focus-within:ring-focus-ring focus-within:ring-inset",
            )}
          >
            <Mark on={Boolean(ownWords)} many={many} className="pointer-coarse:mt-[3px]" />
            <input
              ref={otherRef}
              data-question-other-input=""
              type="text"
              enterKeyHint={otherEnterKeyHint}
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
              className="min-h-5 min-w-0 flex-1 bg-transparent leading-5 text-primary outline-none placeholder:text-placeholder pointer-coarse:min-h-6 pointer-coarse:text-base pointer-coarse:leading-6"
            />
          </div>
        ) : sizer && interactiveMode ? (
          <div className={cn(OPTION_ROW, "border-secondary")}>
            <Mark on={false} many={many} className="pointer-coarse:mt-[3px]" />
            <span className="min-h-5 min-w-0 flex-1 leading-5 pointer-coarse:min-h-6 pointer-coarse:leading-6" />
          </div>
        ) : (
          <div
            role={sizer ? undefined : "option"}
            aria-selected={sizer ? undefined : Boolean(ownWords)}
            data-question-other={sizer ? undefined : ""}
            data-chosen={!sizer && mode === "answered" && ownWords ? "" : undefined}
            className={OPTION_ROW}
          >
            <Mark on={Boolean(ownWords)} many={many} dim={muted} />
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
