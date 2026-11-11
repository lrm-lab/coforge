import { useRouterState } from "@tanstack/react-router";

import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";
import { useBreakpoint } from "#src/hooks/use-breakpoint";

import { BusyAgentsStage } from "./busy-agents-stage";
import { useOpenHeaderAgent } from "./profile-panel/open-agent-profile";

/** The shell sits above every page, not only Chat, so it knows no Direct messages to rank by or
 * open into; one stable empty value keeps the memoized stage from repainting. */
const NO_DIRECTS: ReadonlyMap<string, string> = new Map();
const NO_DIRECT_IDS: ReadonlySet<string> = new Set();

/**
 * The busy Agents the shell shows on every page of the Workspace: in the desktop top bar, just
 * left of the search field (`top-bar`, from `lg` up), or after the title of a phone tab home's
 * header (`tab-home`, below `lg`; Chat's header has its own, `ChatHeaderBusyAgents`, which ranks
 * the Agents it has a Direct message with). On a conversation page pressing one opens its profile
 * beside the conversation; elsewhere it opens the Agent's page. Live agent activity off hides them.
 */
export function ShellBusyAgents({ placement }: { placement: "top-bar" | "tab-home" }) {
  const wide = useBreakpoint("lg");
  const onConversationPage = useRouterState({
    select: (state) =>
      /^\/(channel|dm)\//.test(splitWorkspacePath(state.location.pathname)?.rest ?? ""),
  });
  const openAgent = useOpenHeaderAgent(onConversationPage, NO_DIRECTS);
  const [live] = useLiveAgentActivity();
  if (!live || wide !== (placement === "top-bar")) return null;
  const stage = <BusyAgentsStage directAgentIds={NO_DIRECT_IDS} onOpenAgent={openAgent} />;
  return placement === "top-bar" ? <div className="flex h-12 w-48 min-w-0">{stage}</div> : stage;
}
