import { Link } from "@tanstack/react-router";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import * as m from "#src/paraglide/messages";

export function MemoryScopeLinks() {
  const workspaceSlug = useWorkspaceSlug();
  const classes = "cursor-pointer px-1 py-3 text-sm font-medium text-tertiary hover:text-primary";
  return (
    <nav
      aria-label={m.memory_title()}
      className="flex gap-5 border-b border-secondary px-5 lg:px-8"
    >
      <Link
        to="/w/$workspaceSlug/memory"
        params={{ workspaceSlug }}
        search={{ q: "", archived: false, offset: 0 }}
        activeOptions={{ exact: true }}
        className={classes}
        activeProps={{ className: "text-primary underline underline-offset-8" }}
      >
        {m.memory_title()}
      </Link>
      <Link
        to="/w/$workspaceSlug/memory/personal"
        params={{ workspaceSlug }}
        search={{ q: "", archived: false, offset: 0, agentQuery: "", page: 1, create: false }}
        className={classes}
        activeProps={{ className: "text-primary underline underline-offset-8" }}
      >
        {m.memory_personal()}
      </Link>
    </nav>
  );
}
