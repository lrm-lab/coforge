import { DialogTrigger as AriaDialogTrigger } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
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
 * The count at the end of the chat list header's stage: how many busy Agents wait off stage. It
 * opens every busy Agent, most relevant first, in the thread's following-Agents popover; a row
 * opens that Agent's profile.
 */
export function BusyAgentsCount({
  agents,
  waiting,
  onOpenAgent,
}: {
  agents: readonly BusyAgent[];
  waiting: number;
  onOpenAgent: OpenAgentProfile;
}) {
  return (
    <AriaDialogTrigger>
      <Button
        color="tertiary"
        size="sm"
        aria-label={m.agent_busy_agents_count({ count: agents.length })}
        className="shrink-0 px-1.5 [&>[data-text]]:flex [&>[data-text]]:items-center"
      >
        <span aria-hidden="true" className="tabular-nums">
          {waiting}
        </span>
      </Button>
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
