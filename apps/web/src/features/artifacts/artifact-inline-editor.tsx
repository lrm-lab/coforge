import {
  forwardRef,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
} from "react";
import { closeHistory, history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { Fragment, Schema, type Node as EditorNode } from "@tiptap/pm/model";
import { EditorState, Selection, type Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { Cursor02 } from "@untitledui/icons";

import { activeReferenceQuery } from "#src/features/conversations/reference-completion";
import { ReferenceSuggestionList } from "#src/features/conversations/reference-suggestions";
import { useReferenceSuggestions } from "#src/features/conversations/use-reference-completion";
import { cn } from "#src/lib/utils";
import { useArtifactCommenting } from "./artifact-commenting";
import { useArtifactMentionables } from "./artifact-comment-queries";
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

const schema = new Schema({
  nodes: {
    doc: { content: "inline*" },
    text: { group: "inline" },
    elementRef: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: false,
      attrs: { tag: {}, selector: {}, quote: { default: null } },
      toDOM: (node) => createChipNode(elementRefOf(node)),
    },
  },
});

function elementRefOf(node: EditorNode): InlineElementRef {
  const { tag, selector, quote } = node.attrs as Omit<InlineElementRef, "kind">;
  return { kind: "element", tag, selector, ...(quote ? { quote } : {}) };
}

function segmentsOf(doc: EditorNode): InlineSegment[] {
  const segments: InlineSegment[] = [];
  doc.forEach((node) => {
    if (!node.isText) {
      segments.push(elementRefOf(node));
      return;
    }
    const text = node.text?.replace(/\u200B/g, "");
    if (text) segments.push({ kind: "text", text });
  });
  return segments;
}

function editorState(segments: readonly InlineSegment[] = []) {
  const doc = schema.node(
    "doc",
    null,
    segments.flatMap((segment) =>
      segment.kind === "element"
        ? [schema.node("elementRef", segment)]
        : segment.text
          ? [schema.text(segment.text)]
          : [],
    ),
  );
  return EditorState.create({
    doc,
    selection: Selection.atEnd(doc),
    plugins: [history(), keymap({ "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo })],
  });
}

const editorText = (doc: EditorNode) => doc.textBetween(0, doc.content.size, "\n", " ");

function editAsOneStep(view: EditorView, transaction: Transaction) {
  view.dispatch(closeHistory(transaction));
  view.dispatch(closeHistory(view.state.tr));
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
  const viewRef = useRef<EditorView | null>(null);
  const composingRef = useRef(false);
  const { artifactId } = useArtifactCommenting();
  const { offered } = useArtifactMentionables(artifactId);
  const completion = useReferenceSuggestions({
    mentionables: offered?.people,
    mentionOutsiders: offered?.agents,
    onChoose(item, query) {
      const view = viewRef.current;
      if (!view || item.kind !== "mention" || disabled) return;
      const { doc, selection, tr } = view.state;
      if (!selection.empty) return;
      const source = editorText(doc);
      const caret = selection.from;
      const active = activeReferenceQuery(source, caret);
      if (active?.trigger !== "@" || active.start !== query.start || active.query !== query.query)
        return;
      const followingText = doc.resolve(caret).nodeAfter?.text ?? "";
      const separator = /^[ \t]/.exec(followingText)?.[0];
      const end = caret + (separator?.length ?? 0);
      const inserted = `@${item.mention.handle}${separator ?? " "}`;
      view.focus();
      editAsOneStep(view, tr.insertText(inserted, query.start, end));
    },
  });

  const trackCaret = (view: EditorView) => {
    if (composingRef.current || view.composing) return;
    const { doc, selection } = view.state;
    completion.track(
      editorText(doc),
      !disabled && view.hasFocus() && selection.empty ? selection.from : null,
    );
  };

  const callbacks = useRef({ onSegmentsChange, trackCaret, disabled });
  callbacks.current = { onSegmentsChange, trackCaret, disabled };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const view = new EditorView(
      { mount: root },
      {
        state: editorState(),
        editable: () => !callbacks.current.disabled,
        attributes: ({ doc }) => ({ "data-review-empty": String(doc.content.size === 0) }),
        handlePaste(editor, event) {
          const text = event.clipboardData?.getData("text/plain");
          if (text) editAsOneStep(editor, editor.state.tr.insertText(text));
          return true;
        },
        dispatchTransaction(transaction) {
          view.updateState(view.state.apply(transaction));
          if (transaction.docChanged)
            callbacks.current.onSegmentsChange(segmentsOf(view.state.doc));
          if (transaction.docChanged || transaction.selectionSet)
            callbacks.current.trackCaret(view);
        },
      },
    );
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    view?.setProps({ editable: () => !disabled });
  }, [disabled]);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
        view.focus();
      },
      clear() {
        viewRef.current?.updateState(editorState());
        onSegmentsChange([]);
      },
      setSegments(segments) {
        const view = viewRef.current;
        if (!view) return;
        view.updateState(editorState(segments));
        view.focus();
        onSegmentsChange([...segments]);
      },
      insertElement(elementRef) {
        const view = viewRef.current;
        if (!view || disabled) return;
        const content = Fragment.fromArray([
          schema.node("elementRef", elementRef),
          schema.text(" "),
        ]);
        const { tr, selection } = view.state;
        tr.replaceWith(selection.from, selection.to, content);
        tr.setSelection(Selection.near(tr.doc.resolve(selection.from + content.size)));
        editAsOneStep(view, tr);
        view.focus();
      },
      readSegments() {
        const view = viewRef.current;
        return view ? segmentsOf(view.state.doc) : [];
      },
    }),
    [disabled, onSegmentsChange],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.nativeEvent.isComposing || composingRef.current) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      (onSubmitAndSend ?? onSubmit)();
      return;
    }
    if (completion.handleKeyDown(event)) return;
    if (event.key === "Enter" && event.shiftKey && !event.altKey) {
      event.preventDefault();
      const view = viewRef.current;
      if (view) view.dispatch(view.state.tr.insertText("\n"));
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
    <>
      <div
        ref={rootRef}
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-autocomplete="list"
        aria-controls={completion.open ? completion.listboxId : undefined}
        aria-activedescendant={
          completion.open ? completion.optionId(completion.activeIndex) : undefined
        }
        data-placeholder={placeholder}
        data-review-editor=""
        onCompositionStart={() => {
          composingRef.current = true;
          completion.close();
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          requestAnimationFrame(() => {
            const view = viewRef.current;
            if (view) callbacks.current.trackCaret(view);
          });
        }}
        onBlur={completion.close}
        onKeyDownCapture={onKeyDown}
        className={cn(
          "artifact-review-editor relative min-h-11 max-h-32 w-full overflow-y-auto bg-transparent text-sm leading-snug text-primary whitespace-pre-wrap outline-hidden [overflow-wrap:anywhere]",
          disabled && "pointer-events-none opacity-60",
        )}
      />
      {completion.open && (
        <ReferenceSuggestionList
          id={completion.listboxId}
          trigger="@"
          items={completion.items}
          activeIndex={completion.activeIndex}
          optionId={completion.optionId}
          onChoose={completion.choose}
          onHighlight={completion.setActiveIndex}
          groupBy="kind"
          placement="inline"
        />
      )}
    </>
  );
});

export { segmentsFromDraft };
