import type { RefObject } from "react";

import {
  ContentEditor,
  type ContentEditorRef,
} from "#src/features/records/report-editor/content-editor";
import { m } from "#src/paraglide/messages";

/**
 * A document's title and text as the pane edits them (task #385), for a saved document and a
 * draft alike: Enter in the title moves into the text, and ⌘S / Ctrl+S saves, as in any editor.
 */
export function ArtifactDocumentFields({
  editorRef,
  title,
  text,
  editable,
  onTitle,
  onEdit,
  onText,
  onSave,
}: {
  editorRef: RefObject<ContentEditorRef | null>;
  title: string;
  /** The text the editor starts from; later changes replace it only while nothing is edited. */
  text: string;
  editable: boolean;
  onTitle: (title: string) => void;
  /** The person changed the text: at once, before `onText` has it. */
  onEdit: () => void;
  /** The text after the editor's debounce; a draft reads it from `editorRef` when it saves. */
  onText?: (text: string) => void;
  onSave: () => void;
}) {
  return (
    <>
      <textarea
        // A title is one line that wraps, as a long one would not fit a phone's width.
        rows={1}
        aria-label={m.doc_title_placeholder()}
        placeholder={m.doc_title_placeholder()}
        value={title}
        readOnly={!editable}
        onChange={(event) => onTitle(event.target.value.replace(/[\r\n]+/g, " "))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            editorRef.current?.focus();
          }
        }}
        className="mb-4 w-full resize-none bg-transparent text-display-md font-semibold text-primary outline-hidden [field-sizing:content] placeholder:text-placeholder"
      />
      <div
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSave();
          }
        }}
      >
        <ContentEditor
          ref={editorRef}
          defaultValue={text}
          editable={editable}
          placeholder={m.doc_body_placeholder()}
          debounceMs={150}
          flushOnUnmount
          onEdit={onEdit}
          onUpdate={onText}
        />
      </div>
    </>
  );
}
