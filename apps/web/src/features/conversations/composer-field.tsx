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

/** What sets the width of a line of draft text: shared by the textarea and its hidden one-line
 * copy, which measures whether the draft fits the one-line text column. */
const DRAFT_LINE_CLASS = "pr-3 text-md";

/** On one line beside `+`, the text starts as far from its glyph as the glyph is from the frame
 * (the button's own 8px padding and the 4px column gap already sit between them); anywhere else
 * it is inset like the frame's other content. */
const BESIDE_LEADING_CLASS = "pl-1";
const INSET_CLASS = "pl-3";

/** Puts the caret at the end of the draft, without scrolling the page to it. */
export function focusDraftEnd(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

/**
 * The draft field shared by every composer (a conversation, a thread, a file's comments): the text,
 * its `@`/`#` completion, Enter to send (never while an IME composes or a candidate is being
 * picked), the send button, and the layout that keeps one line while the draft fits and stacks
 * once it does not. The owner keeps the draft, what sending does, and anything around the field.
 */
export function ComposerField({
  completion,
  value,
  onValueChange,
  label,
  placeholder,
  onSubmit,
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
}: {
  /** The owner's `useReferenceCompletion`, whose `onChange` is `onValueChange` too. */
  completion: ReturnType<typeof useReferenceCompletion>;
  value: string;
  onValueChange: (value: string) => void;
  /** The field's accessible name. */
  label: string;
  placeholder: string;
  /** Send the draft: as a Task when `asTask` is true, by the owner's default when it is absent. */
  onSubmit: (asTask?: boolean) => void;
  sendDisabled: boolean;
  isDisabled?: boolean;
  /** Typing is held, focus kept (a send in flight that must not lose the dialog's Escape). */
  isReadOnly?: boolean;
  maxLength?: number;
  /** Whether a send may go "As task" (the send menu, Cmd/Ctrl+Shift+Enter). */
  taskMode?: boolean;
  asTask?: boolean;
  /** Attachments under the text stack the field like a newline does. */
  attachmentCount?: number;
  /** The button before the text (the attachment `+`), given the grid placement it takes. */
  leading?: (className: string) => ReactNode;
  /** Shown under the text, across the field, while stacked (the attachments). */
  below?: ReactNode;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const id = useId();
  // IME composition tracking for Enter-to-send: see composer-behavior.ts.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  // Whether the draft would wrap in the one-line text column, read from a hidden copy of it that
  // always sits in that column (see `forcesStackedLayout`). Once a newline or an attachment
  // stacks the composer anyway, the copy stays empty rather than laying out the draft twice.
  const stacksAnyway = forcesStackedLayout(value, attachmentCount);
  // The placeholder must fit too, or the composer stays stacked and typing never moves the box.
  const lineMirrorText = stacksAnyway ? "" : `${value}\n${placeholder}`;
  const lineMirrorRef = useRef<HTMLSpanElement>(null);
  const [overflowsLine, setOverflowsLine] = useState(false);
  const measureLine = useCallback(() => {
    const mirror = lineMirrorRef.current;
    if (mirror) setOverflowsLine(mirror.scrollWidth > mirror.clientWidth);
  }, []);
  // Before paint, so a restored long draft never shows a frame on one line.
  useLayoutEffect(measureLine, [lineMirrorText, measureLine]);
  useResizeObserver({ ref: lineMirrorRef, onResize: measureLine });
  const stacked = stacksAnyway || overflowsLine;
  // Stacked, `+` and send sit on the bottom bar (row 3, under the attachments).
  const barRow = stacked ? "row-start-3" : "row-start-1";
  const oneLineInset = leading ? BESIDE_LEADING_CLASS : INSET_CLASS;

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The open completion owns navigation and confirmation keys; Enter must not send while a
    // candidate is being picked. During IME composition the keys belong to the IME.
    if (completion.handleKeyDown(event, isComposingRef.current)) return;
    const composition = { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() };
    const key = {
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing || isComposingRef.current,
      keyCode: event.keyCode,
    };
    if (taskMode && shouldSendAsTaskOnEnter(key, composition)) {
      event.preventDefault();
      onSubmit(true);
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
          // Fits what it shows, placeholder included (as Raft's); scrolls only past max height.
          className={cx(
            "row-start-1 max-h-40 min-h-8 w-full resize-none bg-transparent py-1 outline-none [field-sizing:content] placeholder:text-placeholder disabled:opacity-50",
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
          onChoose={(wantTask) => {
            onSubmit(wantTask);
            // The closing menu hands focus back to its trigger; take it back after.
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
        />
      )}
    </>
  );
}
