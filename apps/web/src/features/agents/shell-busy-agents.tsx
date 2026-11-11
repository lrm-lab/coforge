import { useRouterState } from "@tanstack/react-router";

import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";
import { useBreakpoint } from "#src/hooks/use-breakpoint";

import { BusyAgentsStage } from "./busy-agents-stage";
import { useOpenHeaderAgent } from "./profile-panel/open-agent-profile";

/** The top bar sits above every page, not only Chat, so it knows no Direct messages to rank by
 * or open into; one stable empty value keeps the memoized stage from repainting. */
const NO_DIRECTS: ReadonlyMap<string, string> = new Map();
const NO_DIRECT_IDS: ReadonlySet<string> = new Set();

/**
 * The busy Agents in the desktop top bar, just left of the search field, on every page of the Workspace. On a
 * conversation page pressing one opens its profile beside the conversation; elsewhere it opens the
 * Agent's page. Mounted only on a desktop: below `lg` the tab homes' header shows the stage
 * (`PhoneBusyAgents`, and Chat's own `ChatHeaderBusyAgents`). Live agent activity off hides them.
 */
export function TopBarBusyAgents() {
  const wide = useBreakpoint("lg");
  const onConversationPage = useRouterState({
    select: (state) =>
      /^\/(channel|dm)\//.test(splitWorkspacePath(state.location.pathname)?.rest ?? ""),
  });
  const openAgent = useOpenHeaderAgent(onConversationPage, NO_DIRECTS);
  const [live] = useLiveAgentActivity();
  if (!wide || !live) return null;
  return (
    <div className="flex h-12 w-48 min-w-0">
      <BusyAgentsStage directAgentIds={NO_DIRECT_IDS} onOpenAgent={openAgent} />
    </div>
  );
}

/**
 * The busy Agents in a phone tab home's header, after the title (every home but Chat, whose header
 * ranks the Agents it has a Direct message with). A tab home is no conversation, so pressing one
 * opens the Agent's page. Mounted only below `lg`; live agent activity off hides them.
 */
export function PhoneBusyAgents() {
  const wide = useBreakpoint("lg");
  const openAgent = useOpenHeaderAgent(false, NO_DIRECTS);
  const [live] = useLiveAgentActivity();
  if (wide || !live) return null;
  return <BusyAgentsStage directAgentIds={NO_DIRECT_IDS} onOpenAgent={openAgent} />;
}
