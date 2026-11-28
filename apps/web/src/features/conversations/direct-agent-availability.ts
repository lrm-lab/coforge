import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { agentDisplay } from "#src/features/agents/agent-status-display";
import type { DirectConversationView } from "./conversation-types";

export type DirectAgentGuidance =
  | { kind: "no_computer"; agentName: string }
  | {
      kind: "offline";
      agentName: string;
      computerId?: string;
      alertText?: string;
      alertDetail?: string;
    }
  | {
      kind: "external_offline";
      agentName: string;
      alertText?: string;
      alertDetail?: string;
    };

/** Resolves inline guidance for an offline or computerless Agent DM without flashing on unhydrated active agents. */
export function resolveDirectAgentGuidance({
  agent,
  dmWritable,
  display,
}: {
  agent: DirectConversationView["agent"];
  dmWritable?: boolean;
  display?: AgentDisplaySnapshot;
}): DirectAgentGuidance | null {
  if (agent.deletedAt || dmWritable === false || agent.isAppBot) return null;
  const agentName = agent.displayName?.trim() || agent.name;
  const external = agent.hosting === "external";

  if (!external && agent.computerId === null) {
    return { kind: "no_computer", agentName };
  }

  if (!display) return null;
  const status = agentDisplay(display);
  if (status.kind !== "offline") return null;

  const alertFields = {
    ...(status.alertText ? { alertText: status.alertText } : {}),
    ...(status.statusDetail ? { alertDetail: status.statusDetail } : {}),
  };

  if (external) {
    return {
      kind: "external_offline",
      agentName,
      ...alertFields,
    };
  }

  const computerId = agent.computerId ?? (display.computerId || undefined);
  return {
    kind: "offline",
    agentName,
    ...(computerId ? { computerId } : {}),
    ...alertFields,
  };
}
