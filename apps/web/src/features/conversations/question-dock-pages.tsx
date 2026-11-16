import type { ReactNode } from "react";
import { CHOICE_OTHER_TEXT_MAX_LENGTH } from "@lrm/coforge-sdk/agent";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { DockQuestion, Draft, Drafts } from "./question-card-model";
import { AnswerLine, DOCK_ROW, Key, Mark } from "./question-dock-parts";

/**
 * One page of the dock: every page sits in the same grid cell, the current one shown, so the dock
 * keeps one height while the question changes. Its list is where the keys stand; the highlighted
 * row is the list's active descendant, drawn only once keys are in use.
 */
function Page({
  current,
  title,
  label,
  activeId,
  multiselectable,
  readOnly,
  children,
}: {
  current: boolean;
  title?: string;
  label: string;
  activeId?: string;
  multiselectable?: boolean;
  readOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-dock-page-current={current ? "" : undefined}
      inert={!current}
      aria-hidden={current ? undefined : true}
      className={cn("col-start-1 row-start-1 flex min-w-0 flex-col pb-2", !current && "invisible")}
    >
      {title && <p className="px-2 pb-2 text-md font-medium wrap-anywhere text-primary">{title}</p>}
      <div
        data-dock-list=""
        role="listbox"
        tabIndex={current ? 0 : -1}
        aria-label={label}
        aria-multiselectable={multiselectable || undefined}
        aria-readonly={readOnly || undefined}
        aria-activedescendant={current ? activeId : undefined}
        className="flex flex-col outline-none"
      >
        {children}
      </div>
    </div>
  );
}

/** A question's options to tick, then the person's own words when the Agent offers a row for
 * them. Several may be ticked where the marks are boxes, as a form's are. */
export function QuestionPage({
  id,
  question,
  draft,
  current,
  hi,
  kbd,
  readOnly,
  otherRef,
  onHover,
  onPick,
  onDraft,
}: {
  /** The page's id, which its rows' ids extend. */
  id: string;
  question: DockQuestion;
  draft: Draft | undefined;
  current: boolean;
  hi: number;
  kbd: boolean;
  readOnly: boolean;
  otherRef: (element: HTMLInputElement | null) => void;
  onHover: (row: number) => void;
  onPick: (row: number) => void;
  onDraft: (draft: Draft) => void;
}) {
  const many = question.select === "many";
  const otherRow = question.options.length;
  const lit = (row: number) => kbd && current && row === hi && "pointer-fine:bg-secondary";
  return (
    <Page
      current={current}
      title={question.prompt}
      label={question.prompt}
      activeId={kbd ? `${id}-${hi}` : undefined}
      multiselectable={many}
      readOnly={readOnly}
    >
      {question.options.map((option, row) => {
        const on = Boolean(draft?.selection.includes(option.id));
        const highlighted = current && row === hi;
        return (
          <div
            key={option.id}
            id={`${id}-${row}`}
            role="option"
            aria-selected={on}
            aria-keyshortcuts={row < 9 ? String(row + 1) : undefined}
            data-hi={highlighted ? "" : undefined}
            onMouseMove={() => current && !highlighted && onHover(row)}
            onClick={() => current && onPick(row)}
            className={cn(DOCK_ROW, "group/row", lit(row), readOnly && "cursor-default")}
          >
            {!readOnly && <Mark on={on} many={many} />}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="wrap-anywhere text-primary">
                {option.label}
                {option.recommended && (
                  <span className="ml-1.5 text-xs text-quaternary">
                    {m.action_card_questions_recommended()}
                  </span>
                )}
              </span>
              {option.description && (
                <span className="text-xs wrap-anywhere text-tertiary">{option.description}</span>
              )}
            </span>
            {!readOnly && row < 9 && (
              <Key
                className={cn(
                  "ml-auto shrink-0 pointer-coarse:hidden",
                  kbd && highlighted ? "visible" : "invisible group-hover/row:visible",
                )}
              >
                {row + 1}
              </Key>
            )}
          </div>
        );
      })}
      {question.other && !readOnly && (
        <div
          id={`${id}-${otherRow}`}
          role="option"
          aria-selected={Boolean(draft?.text.trim())}
          data-hi={current && hi === otherRow ? "" : undefined}
          onMouseMove={() => current && hi !== otherRow && onHover(otherRow)}
          className={cn(DOCK_ROW, "cursor-text", lit(otherRow))}
        >
          <Mark on={Boolean(draft?.text.trim())} many={many} />
          <input
            ref={otherRef}
            data-dock-other=""
            type="text"
            value={draft?.text ?? ""}
            maxLength={CHOICE_OTHER_TEXT_MAX_LENGTH}
            aria-label={question.other.label || m.dock_own_words()}
            placeholder={question.other.label || m.dock_own_words()}
            onFocus={() => current && onHover(otherRow)}
            onChange={(event) => {
              const text = event.target.value;
              onDraft({
                // A single pick's own words replace its ticked option.
                selection: many || !text.trim() ? (draft?.selection ?? []) : [],
                text,
              });
            }}
            className="h-5 min-w-0 flex-1 bg-transparent text-primary outline-none placeholder:text-placeholder"
          />
        </div>
      )}
    </Page>
  );
}

/** Before sending a card of several questions: each question with its answer, or Skipped; a row
 * goes back to its question. */
export function ReviewPage({
  id,
  questions,
  drafts,
  current,
  hi,
  kbd,
  onHover,
  onTurn,
}: {
  id: string;
  questions: DockQuestion[];
  drafts: Drafts;
  current: boolean;
  hi: number;
  kbd: boolean;
  onHover: (row: number) => void;
  onTurn: (row: number) => void;
}) {
  return (
    <Page current={current} label={m.dock_review()} activeId={kbd ? `${id}-${hi}` : undefined}>
      {questions.map((question, row) => {
        const highlighted = current && row === hi;
        return (
          <div
            key={question.id}
            id={`${id}-${row}`}
            role="option"
            aria-selected={false}
            data-hi={highlighted ? "" : undefined}
            onMouseMove={() => current && !highlighted && onHover(row)}
            onClick={() => onTurn(row)}
            className={cn(DOCK_ROW, kbd && highlighted && "pointer-fine:bg-secondary")}
          >
            <AnswerLine question={question} draft={drafts[question.id]} />
          </div>
        );
      })}
    </Page>
  );
}
