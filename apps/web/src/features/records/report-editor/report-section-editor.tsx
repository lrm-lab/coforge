import type { Ref } from "react";

import { ContentEditor, type ContentEditorProps, type ContentEditorRef } from "./content-editor";
import type { UploadResult } from "./types";

export type ReportSectionEditorProps = {
  defaultValue: string;
  onUpdate: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  /** Lets the owner replace the text after the user has typed, which `defaultValue` cannot. */
  editorRef?: Ref<ContentEditorRef>;
};

/**
 * Weekly-report TipTap body. Statically imported from `/records/$recordId`
 * (`ssr: "data-only"`), matching a client-only eager mount.
 */
export function ReportSectionEditor({
  defaultValue,
  onUpdate,
  onBlur,
  placeholder,
  className,
  editable = true,
  onUploadFile,
  editorRef,
}: ReportSectionEditorProps) {
  const props: ContentEditorProps = {
    defaultValue,
    onUpdate,
    onBlur,
    placeholder,
    className,
    onUploadFile,
    editable,
    showBubbleMenu: editable,
    debounceMs: 150,
  };
  return <ContentEditor ref={editorRef} {...props} />;
}
