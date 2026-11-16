import { ContentEditor } from "#src/features/records/report-editor/content-editor";
import { ArtifactCommentSurface } from "./artifact-comment-surface";

export function ArtifactMarkdown({ path, text }: { path: string; text: string }) {
  return (
    <ArtifactCommentSurface
      path={path}
      kind="text"
      contentClassName="mx-auto w-full max-w-[46rem] px-6 pt-6 pb-16 md:px-10"
    >
      <ContentEditor editable={false} defaultValue={text} />
    </ArtifactCommentSurface>
  );
}
