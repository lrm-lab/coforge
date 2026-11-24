import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/w/$workspaceSlug/_computers/computers")({
  validateSearch: (search: Record<string, unknown>): { add?: 1 } =>
    search.add === "1" || search.add === 1 ? { add: 1 } : {},
  component: ComputersIndexPage,
});

function ComputersIndexPage() {
  return null;
}
