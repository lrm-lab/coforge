import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectObjectQuery } from "./project-tree-queries";
import { RepositorySection } from "./repository-section";

// The editor is TipTap: load it only for a project that has a README, not with the page chunk.
const ContentEditor = lazy(() =>
  import("#src/features/records/report-editor/content-editor").then((module) => ({
    default: module.ContentEditor,
  })),
);

/**
 * The repository's README, rendered under the Files. It is a bonus to the page, not part of the
 * repository status: while it loads, or when it cannot be read or shown as text, no section appears.
 */
export function ProjectReadme({ slug, name, path }: { slug: string; name: string; path: string }) {
  const { data } = useQuery(projectObjectQuery(slug, path));
  if (data?.status !== "ready" || data.node.kind !== "blob" || data.node.text === null) return null;
  return (
    <RepositorySection title={name} files>
      <div className="mx-auto max-w-3xl px-6 py-4">
        <Suspense fallback={null}>
          <ContentEditor editable={false} defaultValue={data.node.text} />
        </Suspense>
      </div>
    </RepositorySection>
  );
}
