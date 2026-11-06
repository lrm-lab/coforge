import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The Tasks page became the Projects page's All tasks (task #596). An old link or bookmark still
 * opens: it lands there with its filters, layout and open Task, which take the same search.
 */
export const Route = createFileRoute("/w/$workspaceSlug/tasks")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/w/$workspaceSlug/projects", params, search, replace: true });
  },
});
