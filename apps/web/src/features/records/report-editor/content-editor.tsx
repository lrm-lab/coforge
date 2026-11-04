/**
 * TipTap Markdown content editor for weekly-report sections.
 * Editing surface: formulas, tables, images, code blocks,
 * slash commands, bubble menu, file paste/drop.
 *
 * This module is only rendered under `/records/$recordId` with `ssr: "data-only"`,
 * matching a client-only TipTap mount (static import, no lazy chunk).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";

import { cn } from "#src/lib/utils";
import { EditorBubbleMenu } from "./bubble-menu";
import { createEditorExtensions } from "./extensions";
import { uploadAndInsertFile } from "#src/features/records/report-editor/extensions/file-upload";
import { FileDropOverlay } from "./file-drop-overlay";
import { applyTableColwidthsFromMarkdown } from "./table-markdown";
import { TableControls } from "./table-controls";
import type { UploadResult } from "./types";
import { useFileDropZone } from "./use-file-drop-zone";
import { openLink } from "#src/features/records/report-editor/utils/link-handler";
import {
  MARKDOWN_CHUNK_THRESHOLD,
  parseMarkdownChunked,
} from "#src/features/records/report-editor/utils/parse-markdown-chunked";
import { preprocessMarkdown } from "#src/features/records/report-editor/utils/preprocess";

import "katex/dist/katex.min.css";
import "#src/features/records/report-editor/styles/index.css";

const BLOB_IMAGE_RE = /!\[[^\]]*\]\(blob:[^)]*\)\n?/g;

function stripBlobUrls(md: string): string {
  return md.replace(BLOB_IMAGE_RE, "");
}

export type ContentEditorProps = {
  defaultValue?: string;
  onUpdate?: (markdown: string) => void;
  /** The person changed the content: called at once, while `onUpdate` waits out `debounceMs`.
   * Content set by the page (the first value, a new `defaultValue`, `setMarkdown`) is no edit. */
  onEdit?: () => void;
  /** An edit still waiting out `debounceMs` is told to `onUpdate` when the editor unmounts, so
   * leaving it loses no typing. Off by default: a caller must expect `onUpdate` while it leaves. */
  flushOnUnmount?: boolean;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  debounceMs?: number;
  editable?: boolean;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  showBubbleMenu?: boolean;
};

export type ContentEditorRef = {
  getMarkdown: () => string;
  clearContent: () => void;
  focus: () => void;
  blur: () => void;
  uploadFile: (file: File) => void;
  setMarkdown: (markdown: string) => void;
};

type MarkdownEmitEditor = {
  isDestroyed: boolean;
  view: { composing: boolean };
  getMarkdown: () => string;
};

export const ContentEditor = forwardRef<ContentEditorRef, ContentEditorProps>(
  function ContentEditor(
    {
      defaultValue = "",
      onUpdate,
      onEdit,
      flushOnUnmount = false,
      onBlur,
      placeholder: placeholderText = "",
      className,
      debounceMs = 300,
      editable = true,
      onUploadFile,
      showBubbleMenu = true,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const onUpdateRef = useRef(onUpdate);
    const onEditRef = useRef(onEdit);
    const flushOnUnmountRef = useRef(flushOnUnmount);
    flushOnUnmountRef.current = flushOnUnmount;
    const onBlurRef = useRef(onBlur);
    const onUploadFileRef = useRef(onUploadFile);
    const mediaModeRef = useRef<"inline" | "external">("inline");
    const lastEmittedRef = useRef<string | null>(null);
    const dirtyRef = useRef(false);
    const markdownEmitEditorRef = useRef<MarkdownEmitEditor | null>(null);

    onUpdateRef.current = onUpdate;
    onEditRef.current = onEdit;
    onBlurRef.current = onBlur;
    onUploadFileRef.current = onUploadFile;

    const scheduleMarkdownEmit = (ed: MarkdownEmitEditor) => {
      if (!editable || !onUpdateRef.current || ed.isDestroyed) return;
      const fire = () => {
        debounceRef.current = undefined;
        if (ed.isDestroyed || ed.view.composing) return;
        const md = stripBlobUrls(ed.getMarkdown()).trimEnd();
        if (md === lastEmittedRef.current) return;
        lastEmittedRef.current = md;
        onUpdateRef.current?.(md);
      };
      if (debounceMs <= 0) {
        fire();
        return;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fire, debounceMs);
    };

    const extensions = useMemo(
      () =>
        createEditorExtensions({
          placeholder: placeholderText,
          onUploadFileRef,
          mediaModeRef,
          enableSlashCommands: true,
          slashCommandMode: "block",
          enableTextStyles: true,
        }),
      [placeholderText],
    );

    const initialMarkdown = useMemo(() => preprocessMarkdown(defaultValue), [defaultValue]);

    const editor = useEditor({
      extensions,
      content: initialMarkdown.length < MARKDOWN_CHUNK_THRESHOLD ? initialMarkdown : "",
      contentType: "markdown",
      immediatelyRender: false,
      editable,
      editorProps: {
        attributes: {
          class: "rich-text-editor ProseMirror focus:outline-none",
        },
        handleClick: (_view, _pos, event) => {
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest("a");
          if (!anchor) return false;
          const href = anchor.getAttribute("href");
          if (!href) return false;
          event.preventDefault();
          openLink(href);
          return true;
        },
      },
      onUpdate: ({ editor: ed, transaction }) => {
        if (!editable) return;
        dirtyRef.current = true;
        // Only a change of the content is an edit (tiptap also tells of a switch to editable).
        if (transaction.docChanged) onEditRef.current?.();
        markdownEmitEditorRef.current = ed as unknown as MarkdownEmitEditor;
        scheduleMarkdownEmit(ed as unknown as MarkdownEmitEditor);
      },
      onBlur: () => {
        if (!editable) return;
        onBlurRef.current?.();
      },
    });

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      // Making the editor (not) editable is no edit: tiptap would tell `onUpdate` by default.
      editor.setEditable(editable, false);
    }, [editor, editable]);

    useEffect(() => {
      if (!editor) return;
      if (initialMarkdown.length < MARKDOWN_CHUNK_THRESHOLD) {
        applyTableColwidthsFromMarkdown(editor, defaultValue);
        return;
      }
      // The parser is the Markdown extension's manager (`storage.markdown` only holds it), and the
      // chunked parse is synchronous.
      const doc = parseMarkdownChunked(editor.storage.markdown.manager, initialMarkdown);
      if (editor.isDestroyed) return;
      editor.commands.setContent(doc, { emitUpdate: false });
      applyTableColwidthsFromMarkdown(editor, defaultValue);
    }, [editor]);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.view.dom.classList.add("note-format");
      return () => {
        editor.view.dom.classList.remove("note-format");
      };
    }, [editor]);

    useEffect(() => {
      if (!editor || dirtyRef.current) return;
      const next = preprocessMarkdown(defaultValue);
      const current = stripBlobUrls(editor.getMarkdown()).trimEnd();
      if (next.trimEnd() === current) return;
      editor.commands.setContent(next, { contentType: "markdown", emitUpdate: false });
      applyTableColwidthsFromMarkdown(editor, defaultValue);
      lastEmittedRef.current = next.trimEnd();
    }, [defaultValue, editor]);

    // `flushOnUnmount`: told while the editor is still there (a layout effect's cleanup runs
    // before tiptap destroys it).
    useLayoutEffect(() => {
      return () => {
        if (!debounceRef.current) return;
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
        if (!flushOnUnmountRef.current) return;
        const ed = markdownEmitEditorRef.current;
        if (!ed || ed.isDestroyed || !onUpdateRef.current) return;
        const md = stripBlobUrls(ed.getMarkdown()).trimEnd();
        if (md !== lastEmittedRef.current) onUpdateRef.current(md);
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => (editor ? stripBlobUrls(editor.getMarkdown()).trimEnd() : ""),
        clearContent: () => {
          editor?.commands.clearContent();
          lastEmittedRef.current = "";
        },
        focus: () => editor?.commands.focus(),
        blur: () => editor?.commands.blur(),
        uploadFile: (file: File) => {
          if (!editor || !onUploadFileRef.current) return;
          void uploadAndInsertFile(editor, file, onUploadFileRef.current);
        },
        setMarkdown: (markdown: string) => {
          if (!editor) return;
          const next = preprocessMarkdown(markdown);
          editor.commands.setContent(next, { contentType: "markdown", emitUpdate: false });
          applyTableColwidthsFromMarkdown(editor, markdown);
          lastEmittedRef.current = stripBlobUrls(next).trimEnd();
          dirtyRef.current = false;
        },
      }),
      [editor],
    );

    const { isDragging } = useFileDropZone({
      enabled: editable && Boolean(onUploadFile),
      onDrop: (files) => {
        if (!editor || !onUploadFileRef.current) return;
        for (const file of files) {
          void uploadAndInsertFile(editor, file, onUploadFileRef.current);
        }
      },
    });

    if (!editor) return null;

    return (
      <div
        ref={rootRef}
        className={cn("report-editor relative", className)}
        onMouseDown={(event: ReactMouseEvent) => {
          if (!editable) return;
          if (event.target === event.currentTarget) {
            editor.commands.focus("end");
          }
        }}
      >
        {isDragging ? <FileDropOverlay /> : null}
        {showBubbleMenu ? <EditorBubbleMenu editor={editor} /> : null}
        <TableControls editor={editor} rootRef={rootRef} />
        <EditorContent editor={editor} />
      </div>
    );
  },
);
