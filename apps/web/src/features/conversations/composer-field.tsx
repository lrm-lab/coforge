import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { readShortcutBindings } from "#src/features/shortcuts/shortcut-bindings";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { isApplePlatform } from "#src/lib/platform";
import { cx } from "#src/utils/cx";
import {
  forcesStackedLayout,
  shouldSendAsTaskOnEnter,
  shouldSendOnEnter,
} from "./composer-behavior";
import { ComposerSendButton } from "./composer-send-button";
import { ReferenceSuggestionList } from "./reference-suggestions";
import type { useReferenceCompletion } from "./use-reference-completion";

const DRAFT_LINE_CLASS = "pe-3 text-md";

const BESIDE_LEADING_CLASS = "ps-1";
const INSET_CLASS = "ps-3";
const OVERFLOW_TOLERANCE_PX = 0.5;

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
  actions,
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
  actions?: (className: string) => ReactNode;
}) {
  const id = useId();
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  const stacksAnyway = alwaysStacked || forcesStackedLayout(value, attachmentCount);
  const lineMirrorText = stacksAnyway ? "" : `${value}\n${placeholder}`;
  const mirrorBoxRef = useRef<HTMLDivElement>(null);
  const mirrorTextRef = useRef<HTMLDivElement>(null);
  const [overflowsLine, setOverflowsLine] = useState(false);

  useEffect(() => {
    if (stacksAnyway) return;
    const box = mirrorBoxRef.current;
    const text = mirrorTextRef.current;
    if (!box || !text || typeof ResizeObserver === "undefined") return;
    let boxWidth = 0;
    let textWidth = 0;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const size = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (entry.target === box) boxWidth = size;
        else if (entry.target === text) textWidth = size;
      }
      if (boxWidth > 0) setOverflowsLine(textWidth - boxWidth > OVERFLOW_TOLERANCE_PX);
    });
    observer.observe(box);
    observer.observe(text);
    return () => observer.disconnect();
  }, [stacksAnyway]);

  const stacked = stacksAnyway || overflowsLine;
  const barRow = stacked ? "row-start-3" : "row-start-1";
  const oneLineInset = leading ? BESIDE_LEADING_CLASS : INSET_CLASS;

  const handleChooseSendMode = useLatestCallback((wantTask: boolean) => {
    if (onTaskMode) onTaskMode(wantTask);
    else onSubmit(wantTask);
    requestAnimationFrame(() => focusDraftEnd(completion.textareaRef.current));
  });

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (completion.handleKeyDown(event, isComposingRef.current)) return;
    const composition = { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() };
    const key = {
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing || isComposingRef.current,
    };
    if (
      taskMode &&
      shouldSendAsTaskOnEnter(
        key,
        composition,
        readShortcutBindings("sendAsTask"),
        isApplePlatform(),
      )
    ) {
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
            "row-start-1 max-h-[min(10rem,25dvh)] min-h-8 w-full resize-none bg-transparent py-1 text-field-text outline-none [field-sizing:content] placeholder:text-field-placeholder disabled:opacity-50",
            DRAFT_LINE_CLASS,
            stacked ? cx("col-span-full", INSET_CLASS) : cx("col-start-2", oneLineInset),
          )}
        />
        <div
          ref={mirrorBoxRef}
          aria-hidden="true"
          className={cx(
            "pointer-events-none invisible col-start-2 h-0 min-w-0 overflow-hidden",
            barRow,
          )}
        >
          {!stacksAnyway && (
            <div
              ref={mirrorTextRef}
              className={cx("w-max whitespace-pre", DRAFT_LINE_CLASS, oneLineInset)}
            >
              {lineMirrorText}
            </div>
          )}
        </div>
        {below}
        {leading?.(cx("col-start-1", barRow, stacked && "mt-1"))}
        {actions ? (
          actions(cx("col-start-3", barRow, stacked && "mt-1"))
        ) : (
          <ComposerSendButton
            asTask={asTask}
            taskMode={taskMode}
            isDisabled={sendDisabled}
            label={sendLabel}
            onChoose={handleChooseSendMode}
            className={cx("col-start-3", barRow, stacked && "mt-1")}
          />
        )}
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
