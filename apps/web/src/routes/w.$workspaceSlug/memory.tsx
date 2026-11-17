import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MemoryPage } from "#src/features/memory/memory-page";
import { memoryCommand } from "#src/features/memory/memory.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";
import * as m from "#src/paraglide/messages";

export const Route = createFileRoute("/w/$workspaceSlug/memory")({
  validateSearch: z.object({
    q: z.string().max(500).catch(""),
    archived: z.boolean().catch(false),
    offset: z.number().int().min(0).max(100000).catch(0),
    project: z.uuid().optional().catch(undefined),
    id: z
      .union([z.uuid(), z.literal("new")])
      .optional()
      .catch(undefined),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
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
    return { list, detail };
  },
  pendingComponent: () => (
    <p role="status" className="p-5 text-sm text-tertiary">
      {m.memory_loading()}
    </p>
  ),
  errorComponent: PageLoadError,
  component: () => (
    <MemoryPage
      search={Route.useSearch()}
      list={Route.useLoaderData().list}
      detail={Route.useLoaderData().detail}
    />
  ),
});
