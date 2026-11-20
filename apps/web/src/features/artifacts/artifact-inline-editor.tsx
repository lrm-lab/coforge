import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { Cursor02 } from "@untitledui/icons";

import { cn } from "#src/lib/utils";
import type { CommentAnchor } from "./artifact-comment-inputs";
import {
  extractElementTag,
  hasInlineRefs,
  parseInlineRefs,
  segmentsFromDraft,
  type InlineElementRef,
  type InlineSegment,
} from "./artifact-inline-refs";

const CHIP_SURFACE_CLASS =
  "inline-flex max-w-44 items-center gap-1 rounded-md bg-utility-orange-50 px-1.5 py-0.5 align-baseline font-mono text-xs font-medium text-primary whitespace-nowrap select-all";

const CURSOR_SVG_MARKUP =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none" aria-hidden="true" class="size-2.5 shrink-0 text-utility-orange-500"><path d="M20.506 10.775c.616-.24.925-.36 1.012-.53a.5.5 0 0 0-.006-.465c-.091-.168-.403-.28-1.026-.503L4.596 3.573c-.51-.183-.764-.275-.93-.217a.5.5 0 0 0-.31.309c-.057.167.034.421.217.931l5.704 15.89c.224.623.335.934.503 1.025a.5.5 0 0 0 .466.006c.17-.086.29-.395.53-1.012l2.596-6.677c.047-.121.07-.181.107-.232a.501.501 0 0 1 .117-.117c.05-.036.111-.06.232-.107l6.678-2.597Z"/></svg>';

export function InlineElementChip({ tag, className }: { tag: string; className?: string }) {
  return (
    <span className={cn(CHIP_SURFACE_CLASS, className)}>
      <Cursor02
        aria-hidden="true"
        strokeWidth={1.25}
        className="size-2.5 shrink-0 fill-current text-utility-orange-500"
      />
      <span className="truncate">{`<${tag}>`}</span>
    </span>
  );
}

export function InlineRefText({
  body,
  anchor,
  path,
}: {
  body: string;
  anchor?: CommentAnchor | null;
  path?: string | null;
}) {
  if (hasInlineRefs(body)) {
    const segments = parseInlineRefs(body);
    return (
      <>
        {segments.map((segment, index) =>
          segment.kind === "element" ? (
            <InlineElementChip
              key={`${index}:${segment.selector}`}
              tag={segment.tag}
              className="mx-0.5"
            />
          ) : (
            <span key={index} className="break-words">
              {segment.text}
            </span>
          ),
        )}
      </>
    );
  }
  const badge = fallbackBadge(anchor ?? null, path ?? null);
  return (
    <>
      {badge &&
        (badge.kind === "element" ? (
          <InlineElementChip tag={badge.tag} className="mr-1.5" />
        ) : (
          <span className="mr-1.5 inline-flex max-w-44 truncate rounded-md bg-utility-orange-50 px-1.5 py-0.5 align-baseline font-mono text-xs font-medium text-utility-orange-700">
            {badge.label}
          </span>
        ))}
      {body && <span className="break-words">{body}</span>}
    </>
  );
}

function fallbackBadge(
  anchor: CommentAnchor | null,
  path: string | null,
): { kind: "element"; tag: string } | { kind: "other"; label: string } | null {
  if (anchor?.type === "element") {
    const selector = typeof anchor.data.selector === "string" ? anchor.data.selector : "";
    if (selector) {
      return {
        kind: "element",
        tag: extractElementTag(selector),
      };
    }
  }
  if (anchor?.type === "text") {
    const quote = typeof anchor.data.quote === "string" ? anchor.data.quote.trim() : "";
    if (quote) {
      return {
        kind: "other",
        label: quote.length > 28 ? `“${quote.slice(0, 28)}…”` : `“${quote}”`,
      };
    }
  }
  if (anchor?.type === "lines") {
    const start = Number(anchor.data.start ?? anchor.data.from ?? 0);
    const end = Number(anchor.data.end ?? anchor.data.to ?? start);
    if (start > 0) {
      return { kind: "other", label: start === end ? `L${start}` : `L${start}–${end}` };
    }
  }
  if (anchor?.type === "page") {
    const label =
      typeof anchor.data.label === "string" && anchor.data.label
        ? anchor.data.label
        : typeof anchor.data.name === "string"
          ? anchor.data.name
          : "";
    if (label) return { kind: "other", label };
  }
  if (!anchor && path) return null;
  return null;
}

export type ArtifactInlineEditorHandle = {
  focus(): void;
  clear(): void;
  setSegments(segments: readonly InlineSegment[]): void;
  insertElement(ref: Omit<InlineElementRef, "kind">): void;
  readSegments(): InlineSegment[];
};

function createChipNode(ref: Omit<InlineElementRef, "kind">): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.inlineEl = "true";
  chip.dataset.tag = ref.tag;
  chip.dataset.selector = ref.selector;
  if (ref.quote) chip.dataset.quote = ref.quote;
  chip.className = `${CHIP_SURFACE_CLASS} mx-0.5`;
  chip.innerHTML = CURSOR_SVG_MARKUP;
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = `<${ref.tag}>`;
  chip.appendChild(label);
  return chip;
}

function collectSegments(root: HTMLElement): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\u200B/g, "");
      if (text) segments.push({ kind: "text", text });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.inlineEl === "true") {
      const tag = el.dataset.tag ?? "el";
      const selector = el.dataset.selector ?? "";
      const quote = el.dataset.quote;
      if (selector) {
        segments.push({
          kind: "element",
          tag,
          selector,
          ...(quote ? { quote } : {}),
        });
      }
      return;
    }
    if (el.tagName === "BR") {
      segments.push({ kind: "text", text: "\n" });
      return;
    }
    const isBlock = el !== root && (el.tagName === "DIV" || el.tagName === "P");
    if (isBlock && segments.length > 0) segments.push({ kind: "text", text: "\n" });
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return segments;
}

function placeCaretEnd(root: HTMLElement) {
  root.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const ArtifactInlineEditor = forwardRef<
  ArtifactInlineEditorHandle,
  {
    label: string;
    placeholder?: string;
    disabled?: boolean;
    onSegmentsChange: (segments: InlineSegment[]) => void;
    onSubmit: () => void;
    onSubmitAndSend?: () => void;
    onCancel: () => void;
  }
>(function ArtifactInlineEditor(
  {
    label,
    placeholder = "",
    disabled = false,
    onSegmentsChange,
    onSubmit,
    onSubmitAndSend,
    onCancel,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);

  const emitChange = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const segments = collectSegments(root);
    if (segments.length === 0 && root.innerHTML !== "") root.innerHTML = "";
    onSegmentsChange(segments);
  }, [onSegmentsChange]);

  const rememberCaret = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (root.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        const root = rootRef.current;
        if (!root) return;
        placeCaretEnd(root);
        rememberCaret();
      },
      clear() {
        const root = rootRef.current;
        if (!root) return;
        root.innerHTML = "";
        savedRangeRef.current = null;
        onSegmentsChange([]);
      },
      setSegments(segments) {
        const root = rootRef.current;
        if (!root) return;
        root.innerHTML = "";
        for (const segment of segments) {
          if (segment.kind === "element") {
            root.appendChild(createChipNode(segment));
          } else {
            root.appendChild(document.createTextNode(segment.text));
          }
        }
        placeCaretEnd(root);
        rememberCaret();
        onSegmentsChange([...segments]);
      },
      insertElement(elementRef) {
        const root = rootRef.current;
        if (!root || disabled) return;
        root.focus();
        const selection = window.getSelection();
        let range: Range;
        if (
          selection &&
          selection.rangeCount > 0 &&
          root.contains(selection.getRangeAt(0).commonAncestorContainer)
        ) {
          range = selection.getRangeAt(0);
        } else if (
          savedRangeRef.current &&
          root.contains(savedRangeRef.current.commonAncestorContainer)
        ) {
          range = savedRangeRef.current.cloneRange();
        } else {
          range = document.createRange();
          range.selectNodeContents(root);
          range.collapse(false);
        }
        range.deleteContents();
        const chip = createChipNode(elementRef);
        const space = document.createTextNode(" ");
        range.insertNode(space);
        range.insertNode(chip);
        range.setStartAfter(space);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        savedRangeRef.current = range.cloneRange();
        emitChange();
      },
      readSegments() {
        return rootRef.current ? collectSegments(rootRef.current) : [];
      },
    }),
    [disabled, emitChange, onSegmentsChange, rememberCaret],
  );

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    rememberCaret();
    emitChange();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      (onSubmitAndSend ?? onSubmit)();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-label={label}
      aria-multiline="true"
      contentEditable={!disabled}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      data-review-editor=""
      onInput={() => {
        rememberCaret();
        emitChange();
      }}
      onKeyUp={rememberCaret}
      onMouseUp={rememberCaret}
      onBlur={rememberCaret}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
      className={cn(
        "artifact-review-editor min-h-11 max-h-32 w-full overflow-y-auto bg-transparent text-sm leading-snug text-primary outline-hidden [overflow-wrap:anywhere]",
        disabled && "pointer-events-none opacity-60",
      )}
    />
  );
});

export { segmentsFromDraft };
