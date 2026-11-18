import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MemoryPage } from "#src/features/memory/memory-page";
import { memoryCommand } from "#src/features/memory/memory.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { MemoryPending } from "#src/features/memory/memory-pending";
import { MemoryVersionPage } from "#src/features/memory/memory-provenance";
import { MemoryReviewPage } from "#src/features/memory/memory-review-page";
import { memorySuggestionCommand } from "#src/features/memory/memory-suggestions.functions";

export const Route = createFileRoute("/w/$workspaceSlug/memory")({
  validateSearch: z.object({
    q: z.string().max(500).catch(""),
    archived: z.boolean().catch(false),
    offset: z.number().int().min(0).max(100000).catch(0),
    project: z.uuid().optional().catch(undefined),
    review: z.boolean().optional().catch(undefined),
    after: z.uuid().optional().catch(undefined),
    revision: z.number().int().positive().max(2_147_483_647).optional().catch(undefined),
    id: z
      .union([z.uuid(), z.literal("new")])
      .optional()
      .catch(undefined),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    if (deps.review)
      return {
        kind: "review" as const,
        suggestions: await memorySuggestionCommand({
          data: { operation: "list", after: deps.after },
        }),
      };
    if (deps.id && deps.id !== "new" && deps.revision)
      return {
        kind: "version" as const,
        detail: await memoryCommand({
          data: { operation: "get", id: deps.id, revision: deps.revision },
        }),
      };
    const [list, detail] = await Promise.all([
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
      deps.id && deps.id !== "new"
        ? memoryCommand({ data: { operation: "get", id: deps.id } })
        : undefined,
    ]);
    return { kind: "memory" as const, list, detail };
  },
  pendingComponent: MemoryPending,
  errorComponent: PageLoadError,
  component: () => {
    const data = Route.useLoaderData();
    const search = Route.useSearch();
    const { workspaceSlug } = Route.useParams();
    if (data.kind === "version") return <MemoryVersionPage detail={data.detail} />;
    return data.kind === "review" ? (
      <MemoryReviewPage key={workspaceSlug} suggestions={data.suggestions} />
    ) : (
      <MemoryPage search={search} list={data.list} detail={data.detail} />
    );
  },
});
