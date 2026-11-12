import { useRouterState } from "@tanstack/react-router";

import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";

import { BusyAgentsStage } from "./busy-agents-stage";
import { useOpenHeaderAgent } from "./profile-panel/open-agent-profile";

/** A tab home other than Chat knows no Direct messages to rank by or open into; one stable empty
 * value keeps the memoized stage from repainting. */
const NO_DIRECTS: ReadonlyMap<string, string> = new Map();
const NO_DIRECT_IDS: ReadonlySet<string> = new Set();

/**
 * The busy Agents after the title of a phone tab home's header (Chat's header has its own,
 * `ChatHeaderBusyAgents`, which ranks the Agents it has a Direct message with, and is the only
 * place a desktop shows them). On a conversation page pressing one opens its profile beside the
 * conversation; elsewhere it opens the Agent's page. Live agent activity off hides them.
 */
export function ShellBusyAgents() {
  const onConversationPage = useRouterState({
    select: (state) =>
      /^\/(channel|dm)\//.test(splitWorkspacePath(state.location.pathname)?.rest ?? ""),
  });
  const openAgent = useOpenHeaderAgent(onConversationPage, NO_DIRECTS);
  const [live] = useLiveAgentActivity();
  if (!live) return null;
  return <BusyAgentsStage directAgentIds={NO_DIRECT_IDS} onOpenAgent={openAgent} />;
}
