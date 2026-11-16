import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useResizeObserver } from "#src/hooks/use-resize-observer";
import { cx } from "#src/utils/cx";
import {
  forcesStackedLayout,
  shouldSendAsTaskOnEnter,
  shouldSendOnEnter,
} from "./composer-behavior";
import { ComposerSendButton } from "./composer-send-button";
import { ReferenceSuggestionList } from "./reference-suggestions";
import type { useReferenceCompletion } from "./use-reference-completion";

const DRAFT_LINE_CLASS = "pr-3 text-md";

const BESIDE_LEADING_CLASS = "pl-1";
const INSET_CLASS = "pl-3";

export function focusDraftEnd(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

export function ComposerField({
  completion,
  value,
  onValueChange,
  label,
  placeholder,
  onSubmit,
  onTaskMode,
  sendDisabled,
  isDisabled,
  isReadOnly,
  maxLength,
  taskMode = false,
  asTask = false,
  attachmentCount = 0,
  leading,
  below,
  onPaste,
  sendLabel,
  mentionGroups,
  alwaysStacked = false,
}: {
  completion: ReturnType<typeof useReferenceCompletion>;
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder: string;
  onSubmit: (asTask?: boolean) => void;
  onTaskMode?: (asTask: boolean) => void;
  sendDisabled: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  maxLength?: number;
  taskMode?: boolean;
  asTask?: boolean;
  attachmentCount?: number;
  leading?: (className: string) => ReactNode;
  below?: ReactNode;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  sendLabel?: string;
  mentionGroups?: "membership" | "kind";
  alwaysStacked?: boolean;
}) {
  const id = useId();
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  const stacksAnyway = alwaysStacked || forcesStackedLayout(value, attachmentCount);
  const lineMirrorText = stacksAnyway ? "" : `${value}\n${placeholder}`;
  const lineMirrorRef = useRef<HTMLSpanElement>(null);
  const [overflowsLine, setOverflowsLine] = useState(false);
  const measureLine = useCallback(() => {
    const mirror = lineMirrorRef.current;
    if (mirror) setOverflowsLine(mirror.scrollWidth > mirror.clientWidth);
  }, []);
  useLayoutEffect(measureLine, [lineMirrorText, measureLine]);
  useResizeObserver({ ref: lineMirrorRef, onResize: measureLine });
  const stacked = stacksAnyway || overflowsLine;
  const barRow = stacked ? "row-start-3" : "row-start-1";
  const oneLineInset = leading ? BESIDE_LEADING_CLASS : INSET_CLASS;

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (completion.handleKeyDown(event, isComposingRef.current)) return;
    const composition = { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() };
    const key = {
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing || isComposingRef.current,
    };
    if (taskMode && shouldSendAsTaskOnEnter(key, composition)) {
      event.preventDefault();
      if (onTaskMode) onTaskMode(true);
      else onSubmit(true);
      return;
    }
    if (shouldSendOnEnter(key, composition)) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      {/* One grid for both shapes: on one line `+`, the text and send share a row; stacked, the
          text spans the top, the attachments sit under it, and `+` and send drop to a bar whose
          middle cell is the one-line text column (so neither may change width between shapes).
          Only classes change, so the textarea (focus, caret, IME state) is never remounted. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-1">
        <textarea
          id={id}
          data-composer
          ref={completion.textareaRef}
          rows={1}
          value={value}
          disabled={isDisabled}
          readOnly={isReadOnly}
          maxLength={maxLength}
          onChange={(event) => {
            onValueChange(event.target.value);
            completion.track(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) =>
            completion.track(event.currentTarget.value, event.currentTarget.selectionStart)
          }
          onBlur={completion.close}
          onKeyDown={keyDown}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            lastCompositionEndAtRef.current = Date.now();
          }}
          onPaste={onPaste}
          aria-expanded={completion.open || undefined}
          aria-controls={completion.open ? completion.listboxId : undefined}
          aria-activedescendant={
            completion.open ? completion.optionId(completion.activeIndex) : undefined
          }
          placeholder={placeholder}
          className={cx(
            "row-start-1 max-h-40 min-h-8 w-full resize-none bg-transparent py-1 text-field-text outline-none [field-sizing:content] placeholder:text-field-placeholder disabled:opacity-50",
            DRAFT_LINE_CLASS,
            stacked ? cx("col-span-full", INSET_CLASS) : cx("col-start-2", oneLineInset),
          )}
        />
        {/* The draft and placeholder, unwrapped, in the one-line column: wider means a wrap. */}
        <span
          ref={lineMirrorRef}
          aria-hidden="true"
          className={cx(
            "invisible col-start-2 h-0 min-w-0 overflow-hidden whitespace-pre",
            DRAFT_LINE_CLASS,
            oneLineInset,
            barRow,
          )}
        >
          {lineMirrorText}
        </span>
        {below}
        {leading?.(cx("col-start-1", barRow, stacked && "mt-1"))}
        <ComposerSendButton
          asTask={asTask}
          taskMode={taskMode}
          isDisabled={sendDisabled}
          label={sendLabel}
          onChoose={(wantTask) => {
            if (onTaskMode) onTaskMode(wantTask);
            else onSubmit(wantTask);
            requestAnimationFrame(() => focusDraftEnd(completion.textareaRef.current));
          }}
          className={cx("col-start-3", barRow, stacked && "mt-1")}
        />
      </div>
      {completion.open && completion.trigger && (
        <ReferenceSuggestionList
          id={completion.listboxId}
          trigger={completion.trigger}
          items={completion.items}
          activeIndex={completion.activeIndex}
          optionId={completion.optionId}
          onChoose={completion.choose}
          onHighlight={completion.setActiveIndex}
          groupBy={mentionGroups}
        />
      )}
    </>
  );
}
