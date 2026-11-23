import { createFileRoute, redirect } from "@tanstack/react-router";
import { personalMemorySearch } from "#src/features/memory/memory-search";

export const Route = createFileRoute("/w/$workspaceSlug/memory_/personal")({
  validateSearch: personalMemorySearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/w/$workspaceSlug/settings/memory/personal",
      params,
      search,
      replace: true,
    });
  },
});
