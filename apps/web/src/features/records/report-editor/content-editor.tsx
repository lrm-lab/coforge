import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";

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
  onDirty?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  sectionGaps?: boolean;
  sectionGapPlaceholder?: string;
  className?: string;
  debounceMs?: number;
  editable?: boolean;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  showBubbleMenu?: boolean;
};

export type ContentEditorRef = {
  getMarkdown: () => string;
  clearContent: () => void;
  blur: () => void;
  uploadFile: (file: File) => void;
  setMarkdown: (markdown: string) => void;
  flush: () => void;
  markClean: () => void;
};

type MarkdownEmitEditor = {
  isDestroyed: boolean;
  view: { composing: boolean };
  getMarkdown: () => string;
};

function EditorFileDropZone({
  editor,
  onUploadFileRef,
}: {
  editor: Editor;
  onUploadFileRef: RefObject<((file: File) => Promise<UploadResult | null>) | undefined>;
}) {
  const { isDragging } = useFileDropZone({
    enabled: true,
    onDrop: (files) => {
      if (editor.isDestroyed || !onUploadFileRef.current) return;
      for (const file of files) {
        void uploadAndInsertFile(editor, file, onUploadFileRef.current);
      }
    },
  });
  return isDragging ? <FileDropOverlay /> : null;
}

export const ContentEditor = forwardRef<ContentEditorRef, ContentEditorProps>(
  function ContentEditor(
    {
      defaultValue = "",
      onUpdate,
      onDirty,
      onBlur,
      placeholder: placeholderText = "",
      sectionGaps = false,
      sectionGapPlaceholder,
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
    const onDirtyRef = useRef(onDirty);
    const onBlurRef = useRef(onBlur);
    const onUploadFileRef = useRef(onUploadFile);
    const editableRef = useRef(editable);
    const debounceMsRef = useRef(debounceMs);
    const mediaModeRef = useRef<"inline" | "external">("inline");
    const lastEmittedRef = useRef<string | null>(null);
    const dirtyRef = useRef(false);
    const pendingEmitRef = useRef(false);
    const activeEditorRef = useRef<MarkdownEmitEditor | null>(null);
    const appliedDefaultRef = useRef(defaultValue);

    useLayoutEffect(() => {
      onUpdateRef.current = onUpdate;
      onDirtyRef.current = onDirty;
      onBlurRef.current = onBlur;
      onUploadFileRef.current = onUploadFile;
      editableRef.current = editable;
      debounceMsRef.current = debounceMs;
    });

    const emitMarkdown = (ed: MarkdownEmitEditor, allowComposing: boolean) => {
      if (!editableRef.current || !onUpdateRef.current || ed.isDestroyed) return;
      if (!allowComposing && ed.view.composing) return;
      pendingEmitRef.current = false;
      const md = stripBlobUrls(ed.getMarkdown()).trimEnd();
      if (md === lastEmittedRef.current) return;
      lastEmittedRef.current = md;
      onUpdateRef.current(md);
    };

    const flushPendingUpdate = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
      if (!pendingEmitRef.current) return;
      const ed = activeEditorRef.current;
      if (!ed) return;
      emitMarkdown(ed, true);
    };

    const scheduleMarkdownEmit = (ed: MarkdownEmitEditor) => {
      if (!editableRef.current || !onUpdateRef.current || ed.isDestroyed) return;
      pendingEmitRef.current = true;
      const delay = debounceMsRef.current;
      if (delay <= 0) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = undefined;
        }
        emitMarkdown(ed, false);
        return;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined;
        emitMarkdown(ed, false);
      }, delay);
    };

    const extensions = useMemo(
      () =>
        createEditorExtensions({
          editable,
          placeholder: placeholderText,
          onUploadFileRef,
          mediaModeRef,
          enableSlashCommands: editable,
          slashCommandMode: "block",
          enableTextStyles: true,
          sectionGaps: editable && sectionGaps,
          sectionGapPlaceholder,
        }),
      [editable, placeholderText, sectionGaps, sectionGapPlaceholder],
    );

    const [initialSeed, setInitialSeed] = useState(() => ({
      editable,
      raw: defaultValue,
      processed: preprocessMarkdown(defaultValue),
    }));
    if (initialSeed.editable !== editable) {
      setInitialSeed({
        editable,
        raw: defaultValue,
        processed: preprocessMarkdown(defaultValue),
      });
    }
    const initialMarkdown = initialSeed.processed;
    const initialRawMarkdown = initialSeed.raw;

    const editor = useEditor(
      {
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
        onUpdate: ({ editor: ed }) => {
          if (!editableRef.current) return;
          const emitEditor = ed as unknown as MarkdownEmitEditor;
          activeEditorRef.current = emitEditor;
          const wasDirty = dirtyRef.current;
          dirtyRef.current = true;
          if (!wasDirty) onDirtyRef.current?.();
          scheduleMarkdownEmit(emitEditor);
        },
        onBlur: () => {
          if (!editableRef.current) return;
          flushPendingUpdate();
          onBlurRef.current?.();
        },
        onDestroy: () => {
          flushPendingUpdate();
        },
      },
      [editable],
    );

    useLayoutEffect(() => {
      activeEditorRef.current = editor as unknown as MarkdownEmitEditor | null;
    }, [editor]);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.setEditable(editable, false);
    }, [editor, editable]);

    useEffect(() => {
      if (!editor) return;
      appliedDefaultRef.current = initialRawMarkdown;
      dirtyRef.current = false;
      pendingEmitRef.current = false;
      if (initialMarkdown.length < MARKDOWN_CHUNK_THRESHOLD) {
        applyTableColwidthsFromMarkdown(editor, initialRawMarkdown);
        return;
      }
      const doc = parseMarkdownChunked(editor.storage.markdown.manager, initialMarkdown);
      if (editor.isDestroyed) return;
      editor.commands.setContent(doc, { emitUpdate: false });
      applyTableColwidthsFromMarkdown(editor, initialRawMarkdown);
    }, [editor, initialMarkdown, initialRawMarkdown]);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.view.dom.classList.add("note-format");
      return () => {
        editor.view.dom.classList.remove("note-format");
      };
    }, [editor]);

    useEffect(() => {
      if (!editor || dirtyRef.current) return;
      if (defaultValue === appliedDefaultRef.current) return;
      appliedDefaultRef.current = defaultValue;
      if (defaultValue.trimEnd() === lastEmittedRef.current) return;
      const next = preprocessMarkdown(defaultValue);
      const current = stripBlobUrls(editor.getMarkdown()).trimEnd();
      if (next.trimEnd() === current) return;
      editor.commands.setContent(next, { contentType: "markdown", emitUpdate: false });
      applyTableColwidthsFromMarkdown(editor, defaultValue);
      lastEmittedRef.current = next.trimEnd();
    }, [defaultValue, editor]);

    useEffect(() => {
      return () => {
        flushPendingUpdate();
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => (editor ? stripBlobUrls(editor.getMarkdown()).trimEnd() : ""),
        clearContent: () => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = undefined;
          }
          pendingEmitRef.current = false;
          editor?.commands.clearContent();
          lastEmittedRef.current = "";
        },
        blur: () => editor?.commands.blur(),
        uploadFile: (file: File) => {
          if (!editor || !onUploadFileRef.current) return;
          void uploadAndInsertFile(editor, file, onUploadFileRef.current);
        },
        setMarkdown: (markdown: string) => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = undefined;
          }
          pendingEmitRef.current = false;
          if (!editor) return;
          const next = preprocessMarkdown(markdown);
          editor.commands.setContent(next, { contentType: "markdown", emitUpdate: false });
          applyTableColwidthsFromMarkdown(editor, markdown);
          appliedDefaultRef.current = markdown;
          lastEmittedRef.current = stripBlobUrls(next).trimEnd();
          dirtyRef.current = false;
        },
        flush: () => {
          flushPendingUpdate();
        },
        markClean: () => {
          dirtyRef.current = false;
        },
      }),
      [editor],
    );

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
        {editable && onUploadFile ? (
          <EditorFileDropZone editor={editor} onUploadFileRef={onUploadFileRef} />
        ) : null}
        {editable && showBubbleMenu ? <EditorBubbleMenu editor={editor} /> : null}
        {editable ? <TableControls editor={editor} rootRef={rootRef} /> : null}
        <EditorContent editor={editor} />
      </div>
    );
  },
);
