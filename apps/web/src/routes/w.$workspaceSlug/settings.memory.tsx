import { createFileRoute } from "@tanstack/react-router";
import { teamMemorySearch } from "#src/features/memory/memory-search";
import { MemoryPage } from "#src/features/memory/memory-page";
import { memoryCommand, memoryDetail } from "#src/features/memory/memory.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { MemoryPending } from "#src/features/memory/memory-pending";
import { MemoryVersionPage } from "#src/features/memory/memory-provenance";
import { MemoryReviewPage } from "#src/features/memory/memory-review-page";
import { memorySuggestionCommand } from "#src/features/memory/memory-suggestions.functions";

export const Route = createFileRoute("/w/$workspaceSlug/settings/memory")({
  validateSearch: teamMemorySearch,
  loaderDeps: ({ search }) => teamMemorySearch.parse(search),
  loader: async ({ deps }) => {
    if (deps.review)
      return {
        kind: "review" as const,
        suggestions: await memorySuggestionCommand({
          data: { operation: "list", after: deps.after },
        }),
      };
    const id = deps.id && deps.id !== "new" ? deps.id : undefined;
    const detailRead = id ? memoryDetail({ data: { id, revision: deps.revision } }) : undefined;
    if (detailRead && deps.revision) {
      return { kind: "version" as const, ...(await detailRead) };
    }
    const [list, selected] = await Promise.all([
      memoryCommand({
        data: deps.q
          ? {
              operation: "search",
              query: deps.q,
              offset: deps.offset,
              projectId: deps.project,
              archived: deps.archived,
            }
          : {
              operation: "list",
              archived: deps.archived,
              offset: deps.offset,
              projectId: deps.project,
            },
      }),
      detailRead,
    ]);
    return { kind: "memory" as const, list, detail: selected?.detail, graph: selected?.graph };
  },
  pendingComponent: MemoryPending,
  errorComponent: ({ error }) => <PageLoadError error={error} embedded />,
  component: () => {
    const data = Route.useLoaderData();
    const search = Route.useSearch();
    const { workspaceSlug } = Route.useParams();
    if (data.kind === "version")
      return <MemoryVersionPage detail={data.detail} graph={data.graph} />;
    return data.kind === "review" ? (
      <MemoryReviewPage key={workspaceSlug} suggestions={data.suggestions} />
    ) : (
      <MemoryPage search={search} list={data.list} detail={data.detail} graph={data.graph} />
    );
  },
});
