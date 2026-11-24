import type { Ref } from "react";

import { ContentEditor, type ContentEditorProps, type ContentEditorRef } from "./content-editor";
import type { UploadResult } from "./types";
import { m } from "#src/paraglide/messages";

export type ReportSectionEditorProps = {
  defaultValue: string;
  onUpdate: (markdown: string) => void;
  onDirty?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  debounceMs?: number;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  editorRef?: Ref<ContentEditorRef>;
};

export function ReportSectionEditor({
  defaultValue,
  onUpdate,
  onDirty,
  onBlur,
  placeholder,
  className,
  editable = true,
  debounceMs = 250,
  onUploadFile,
  editorRef,
}: ReportSectionEditorProps) {
  const props: ContentEditorProps = {
    defaultValue,
    onUpdate,
    onDirty,
    onBlur,
    placeholder,
    className,
    onUploadFile,
    editable,
    showBubbleMenu: editable,
    debounceMs,
    sectionGaps: true,
    sectionGapPlaceholder: m.records_section_placeholder(),
  };
  return <ContentEditor ref={editorRef} {...props} />;
}
