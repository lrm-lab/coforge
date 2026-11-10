import { DialogTrigger as AriaDialogTrigger } from "react-aria-components";

import { ChevronDown } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

import { AgentListPopover, AgentListRow, AgentListRows } from "./agent-list-popover";
import type { BusyAgent } from "./busy-agents";
import type { OpenAgentProfile } from "./profile-panel/open-agent-profile";
import { useLiveAgent } from "./workspace-agents-realtime";

function BusyAgentRow({ agent, onOpen }: { agent: BusyAgent; onOpen: () => void }) {
  const live = useLiveAgent(agent.id);
  return (
    <AgentListRow
      agentId={agent.id}
      name={agent.name}
      src={agent.avatarUrl}
      mascot={agent.mascot}
      display={live?.display}
      caption={agent.label}
      onOpenProfile={onOpen}
    />
  );
}

/**
 * The button at the end of the busy Agents' stage while some wait off stage: no number, the
 * mascots carry it, and the tooltip says how many are busy. It opens every busy Agent, most relevant first, in the thread's following-Agents popover; a row
 * opens that Agent's profile.
 */
export function BusyAgentsMore({
  agents,
  onOpenAgent,
}: {
  agents: readonly BusyAgent[];
  onOpenAgent: OpenAgentProfile;
}) {
  return (
    <AriaDialogTrigger>
      <ButtonUtility
        icon={ChevronDown}
        size="xs"
        color="tertiary"
        tooltip={m.agent_busy_agents_count({ count: agents.length })}
        className="shrink-0"
      />
      <AgentListPopover label={m.agent_busy_agents()}>
        {(close) => (
          <AgentListRows>
            {agents.map((agent) => (
              <BusyAgentRow
                key={agent.id}
                agent={agent}
                onOpen={() => {
                  close();
                  onOpenAgent(agent.id);
                }}
              />
            ))}
          </AgentListRows>
        )}
      </AgentListPopover>
    </AriaDialogTrigger>
  );
}
