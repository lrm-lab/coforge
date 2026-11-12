import { ContentEditor } from "#src/features/records/report-editor/content-editor";

/** A Markdown artifact's text to read; an Agent writes it, so it is shown, never edited. */
export function ArtifactMarkdown({ text }: { text: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[46rem] px-6 pt-6 pb-16 md:px-10">
        <ContentEditor editable={false} defaultValue={text} />
      </div>
    </div>
  );
}
