import { useEffect } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { useBreakpoint } from "#src/hooks/use-breakpoint";

const computersRoute = getRouteApi("/w/$workspaceSlug/_computers");

export const Route = createFileRoute("/w/$workspaceSlug/_computers/computers")({
  // `?add=1` opens the add-a-Computer dialog (`_computers.tsx`): the link a person with no
  // Computer of their own is sent to.
  validateSearch: (search: Record<string, unknown>): { add?: 1 } =>
    // The router reads `1` as a number and writes a string back with quotes (`add="1"`), so the
    // flag is the number.
    search.add === "1" || search.add === 1 ? { add: 1 } : {},
  component: ComputersIndexPage,
});

function ComputersIndexPage() {
  const { computers } = computersRoute.useLoaderData();
  const { workspaceSlug } = Route.useParams();
  const navigate = Route.useNavigate();
  const { add } = Route.useSearch();
  // Only one's own: someone else's Computer is never opened unasked.
  const computerId = computers.find((computer) => computer.ownedByCurrentUser)?.id;
  const desktop = useBreakpoint("md");
  useEffect(() => {
    // Mobile starts with the list. Desktop opens on the person's own first Computer.
    if (!desktop || !computerId || add) return;
    void navigate({
      to: "/w/$workspaceSlug/computer/$computerId",
      params: { workspaceSlug, computerId },
      replace: true,
    });
  }, [desktop, workspaceSlug, computerId, add, navigate]);
  // The layout owns the list and the state for a person with no Computer of their own.
  return null;
}
