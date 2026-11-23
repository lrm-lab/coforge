import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import * as m from "#src/paraglide/messages";

export function MemoryScopeLinks({
  review = false,
  showReview = review,
  actions,
}: {
  review?: boolean;
  showReview?: boolean;
  actions?: ReactNode;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const classes = "cursor-pointer px-1 py-3 text-sm font-medium text-tertiary hover:text-primary";
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 border-b border-secondary px-page">
      <nav aria-label={m.memory_title()} className="flex flex-wrap gap-x-5">
        <Link
          to="/w/$workspaceSlug/settings/memory"
          params={{ workspaceSlug }}
          search={{ q: "", archived: false, offset: 0 }}
          activeOptions={{ exact: true }}
          className={classes}
          activeProps={review ? {} : { className: "text-primary underline underline-offset-8" }}
        >
          {m.memory_title()}
        </Link>
        {showReview && (
          <Link
            to="/w/$workspaceSlug/settings/memory"
            params={{ workspaceSlug }}
            search={{ q: "", archived: false, offset: 0, review: true }}
            className={review ? `${classes} text-primary underline underline-offset-8` : classes}
            aria-current={review ? "page" : undefined}
          >
            {m.memory_review_tab()}
          </Link>
        )}
        <Link
          to="/w/$workspaceSlug/settings/memory/personal"
          params={{ workspaceSlug }}
          search={{ q: "", archived: false, offset: 0, agentQuery: "", page: 1, create: false }}
          className={classes}
          activeProps={{ className: "text-primary underline underline-offset-8" }}
        >
          {m.memory_personal()}
        </Link>
      </nav>
      {actions && <div className="ms-auto py-1">{actions}</div>}
    </div>
  );
}
