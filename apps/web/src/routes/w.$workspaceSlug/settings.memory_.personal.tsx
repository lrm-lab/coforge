import { MemoryPending } from "#src/features/memory/memory-pending";
import { createFileRoute } from "@tanstack/react-router";
import { personalMemorySearch } from "#src/features/memory/memory-search";
import { PersonalMemoryPage } from "#src/features/memory/personal-memory-page";
import {
  listMyMemoryAgents,
  personalMemoryCommand,
} from "#src/features/memory/personal-memory.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";

export const Route = createFileRoute("/w/$workspaceSlug/settings/memory_/personal")({
  validateSearch: personalMemorySearch,
  loaderDeps: ({ search }) => personalMemorySearch.parse(search),
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
      deps.agent && deps.key && !deps.create
        ? personalMemoryCommand({
            data: { agentId: deps.agent, command: { operation: "get", key: deps.key } },
          })
        : undefined,
    ]);
    return { agents, list, detail };
  },
  pendingComponent: MemoryPending,
  errorComponent: ({ error }) => <PageLoadError error={error} embedded />,
  component: PersonalMemoryRoutePage,
});

function PersonalMemoryRoutePage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  return (
    <PersonalMemoryPage
      search={search}
      agents={data.agents}
      list={data.list}
      detail={data.detail}
    />
  );
}
