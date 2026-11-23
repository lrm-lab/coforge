import { createFileRoute, redirect } from "@tanstack/react-router";
import { teamMemorySearch } from "#src/features/memory/memory-search";

export const Route = createFileRoute("/w/$workspaceSlug/memory")({
  validateSearch: teamMemorySearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/w/$workspaceSlug/settings/memory", params, search, replace: true });
  },
});
