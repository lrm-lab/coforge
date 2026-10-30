import { useEffect } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { useBreakpoint } from "#src/hooks/use-breakpoint";

const computersRoute = getRouteApi("/w/$workspaceSlug/_computers");

export const Route = createFileRoute("/w/$workspaceSlug/_computers/computers")({
  // `?add=1` opens the add-a-Computer dialog (`_computers.tsx`): the link a person with no
  // Computer of their own is sent to, where the page's usual first selection would show someone else's.
  validateSearch: (search: Record<string, unknown>): { add?: "1" } =>
    search.add === "1" || search.add === 1 ? { add: "1" } : {},
  component: ComputersIndexPage,
});

function ComputersIndexPage() {
  const { computers } = computersRoute.useLoaderData();
  const { workspaceSlug } = Route.useParams();
  const navigate = Route.useNavigate();
  const { add } = Route.useSearch();
  const computerId = computers[0]?.id;
  const desktop = useBreakpoint("md");
  useEffect(() => {
    // Mobile starts with the list. Desktop retains its initial selection.
    if (!desktop || !computerId || add) return;
    void navigate({
      to: "/w/$workspaceSlug/computer/$computerId",
      params: { workspaceSlug, computerId },
      replace: true,
    });
  }, [desktop, workspaceSlug, computerId, add, navigate]);
  // The layout owns the list and the no-Computers state.
  return null;
}
