import { Link } from "@tanstack/react-router";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";

/** Settings → Applications' way into the review queue, for a platform operator. */
export function AppReviewLink() {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <Link
      to="/w/$workspaceSlug/app-review"
      params={{ workspaceSlug }}
      className="rounded-sm text-sm font-semibold text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2"
    >
      {m.apps_review_link()}
    </Link>
  );
}
