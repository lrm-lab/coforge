import { MemoryPending } from "#src/features/memory/memory-pending";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PersonalMemoryPage } from "#src/features/memory/personal-memory-page";
import {
  listMyMemoryAgents,
  personalMemoryCommand,
} from "#src/features/memory/personal-memory.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";

export const Route = createFileRoute("/w/$workspaceSlug/memory_/personal")({
  validateSearch: z.object({
    agent: z.uuid().optional().catch(undefined),
    key: z
      .string()
      .max(80)
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .optional()
      .catch(undefined),
    q: z.string().max(500).catch(""),
    archived: z.boolean().catch(false),
    offset: z.number().int().min(0).max(100000).catch(0),
    agentQuery: z.string().max(100).catch(""),
    page: z.number().int().min(1).max(5000).catch(1),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [agents, list, detail] = await Promise.all([
      listMyMemoryAgents({
        data: { query: deps.agentQuery, page: deps.page, selected: deps.agent },
      }),
      deps.agent
        ? personalMemoryCommand({
            data: {
              agentId: deps.agent,
              command: deps.q
                ? {
                    operation: "search",
                    query: deps.q,
                    offset: deps.offset,
                    archived: deps.archived,
                  }
                : { operation: "list", archived: deps.archived, offset: deps.offset },
            },
          })
        : undefined,
      deps.agent && deps.key && deps.key !== "new"
        ? personalMemoryCommand({
            data: { agentId: deps.agent, command: { operation: "get", key: deps.key } },
          })
        : undefined,
    ]);
    return { agents, list, detail };
  },
  pendingComponent: MemoryPending,
  errorComponent: PageLoadError,
  component: () => {
    const data = Route.useLoaderData();
    return (
      <PersonalMemoryPage
        search={Route.useSearch()}
        agents={data.agents}
        list={data.list}
        detail={data.detail}
      />
    );
  },
});
