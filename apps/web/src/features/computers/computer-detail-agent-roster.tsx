import { useState } from "react";
import { Plus } from "@untitledui/icons";
import { Checkbox as AriaCheckbox } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { m } from "#src/paraglide/messages";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { AgentControlDialogs } from "#src/features/agents/agent-control-dialogs";
import {
  useAgentRuntimeControls,
  type AgentControlExecute,
} from "#src/features/agents/agent-runtime-controls";
import { DetailGroup } from "./computer-detail-rows";
import type { ComputerDetailView } from "./computer-detail-view";

export function ComputerDetailAgentRoster({
  agents,
  onCreateAgent,
  onSelectAgent,
  onExecute,
  canFullReset,
  computerOnline,
  computerName,
}: {
  agents: ComputerDetailView["agents"];
  onCreateAgent?: () => void;
  onSelectAgent?: (agentId: string) => void;
  onExecute?: AgentControlExecute;
  canFullReset: boolean;
  computerOnline: boolean;
  computerName: string;
}) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failedNames, setFailedNames] = useState<string[]>([]);
  const selectedAgents = agents.filter((agent) => selectedIds.has(agent.id));
  const selectionName = selectedAgents.map((agent) => agent.displayName).join(", ");
  const control = useAgentRuntimeControls({
    agentId: selectedAgents[0]?.id ?? "",
    agentName: selectionName,
    canFullReset,
    computerOnline,
    computerLabel: computerName,
    onExecute: async (request) => {
      if (!onExecute || !selectedAgents.length || busy) return;
      setBusy(true);
      setFailedNames([]);
      try {
        const results = await Promise.allSettled(
          selectedAgents.map((agent) =>
            onExecute({ ...request, agentId: agent.id, requestId: crypto.randomUUID() }),
          ),
        );
        const failed = selectedAgents.filter(
          (_agent, index) => results[index]?.status === "rejected",
        );
        setFailedNames(failed.map((agent) => agent.displayName));
        if (failed.length) throw new Error("Some Agent control requests failed");
      } finally {
        setBusy(false);
      }
    },
  });
  const locked = busy || control.stopConfirmOpen || control.restartOpen;
  return (
    <>
      <DetailGroup
        heading={`${m.computer_agents_on_computer()} (${agents.length})`}
        headingId="computer-agents-on-computer"
        action={
          <div className="flex flex-wrap justify-end gap-2">
            {selecting ? (
              <>
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={locked}
                  onPress={() =>
                    setSelectedIds(
                      selectedAgents.length === agents.length
                        ? new Set()
                        : new Set(agents.map((agent) => agent.id)),
                    )
                  }
                >
                  {selectedAgents.length === agents.length
                    ? m.computer_agents_clear_all()
                    : m.computer_agents_select_all()}
                </Button>
                <Button
                  size="sm"
                  color="tertiary"
                  isDisabled={locked}
                  onPress={() => {
                    setSelecting(false);
                    setSelectedIds(new Set());
                    setFailedNames([]);
                  }}
                >
                  {m.controls_cancel()}
                </Button>
              </>
            ) : (
              <>
                {onExecute && agents.length > 0 && (
                  <Button size="sm" color="secondary" onPress={() => setSelecting(true)}>
                    {m.computer_agent_select()}
                  </Button>
                )}
                {onCreateAgent && (
                  <Button size="sm" color="secondary" iconLeading={Plus} onPress={onCreateAgent}>
                    {m.computer_agent_create()}
                  </Button>
                )}
              </>
            )}
          </div>
        }
      >
        {selecting && selectedAgents.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 py-3">
            <span className="mr-auto text-sm text-tertiary">
              {m.computer_agents_selected({ count: String(selectedAgents.length) })}
            </span>
            <Button
              size="sm"
              color="secondary"
              isDisabled={locked}
              onPress={control.pressStartOrStop}
            >
              {m.agent_control_start()}
            </Button>
            <Button
              size="sm"
              color="secondary"
              isDisabled={locked}
              onPress={() => control.setStopConfirmOpen(true)}
            >
              {m.agent_control_stop()}
            </Button>
            <Button
              size="sm"
              color="secondary"
              isDisabled={locked}
              onPress={() => control.openRestart()}
            >
              {m.agent_control_restart_reset_tooltip()}
            </Button>
          </div>
        )}
        {failedNames.length > 0 && (
          <p role="alert" className="py-2 text-sm text-error-primary">
            {m.computer_agents_control_failed({ names: failedNames.join(", ") })}
          </p>
        )}
        {control.startDeferred && (
          <p className="py-2 text-sm text-tertiary">
            {m.agent_control_start_deferred_notice({ computer: computerName })}
          </p>
        )}
        {agents.length ? (
          <ul className="divide-y divide-secondary">
            {agents.map((agent) => {
              const handle = (
                <span className="ml-auto shrink-0 text-xs text-tertiary">@{agent.name}</span>
              );
              const toggle = (selected: boolean) =>
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (selected) next.add(agent.id);
                  else next.delete(agent.id);
                  return next;
                });
              return (
                <li key={agent.id}>
                  {selecting ? (
                    // While selecting, the whole row is the checkbox's own label: one control, so a
                    // click anywhere toggles selection and nothing interactive nests inside
                    // anything else interactive. Same shape as the channel member picker.
                    <AriaCheckbox
                      aria-label={m.computer_agent_select_named({ name: agent.displayName })}
                      isDisabled={locked}
                      isSelected={selectedIds.has(agent.id)}
                      onChange={toggle}
                      className="flex w-full cursor-pointer items-center gap-3 py-3 text-sm hover:bg-primary_hover disabled:cursor-not-allowed"
                    >
                      {({ isSelected, isDisabled, isFocusVisible }) => (
                        <>
                          <CheckboxBase
                            isSelected={isSelected}
                            isDisabled={isDisabled}
                            isFocusVisible={isFocusVisible}
                          />
                          <AgentRosterIdentity agent={agent} />
                          {handle}
                        </>
                      )}
                    </AriaCheckbox>
                  ) : onSelectAgent ? (
                    // Otherwise the row itself opens the Agent — no trailing "Open" button to aim
                    // at. Its accessible name is its own content (name, runtime, handle). The
                    // official Button carries the row: `h-auto`/`py-3` keep the list's rhythm,
                    // `rounded-none px-0` let the hover fill the row, and `font-normal` leaves the
                    // runtime line at its own weight instead of the Button's semibold.
                    <Button
                      color="tertiary"
                      size="sm"
                      onPress={() => onSelectAgent(agent.id)}
                      className="h-auto w-full justify-start rounded-none px-0 py-3 text-left font-normal *:data-text:w-full *:data-text:min-w-0"
                    >
                      <span className="flex w-full min-w-0 items-center gap-3">
                        <AgentRosterIdentity agent={agent} />
                        {handle}
                      </span>
                    </Button>
                  ) : (
                    <span className="flex w-full items-center gap-3 py-3 text-sm">
                      <AgentRosterIdentity agent={agent} />
                      {handle}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-tertiary">
            {m.computer_no_agents_on_computer()}
          </p>
        )}
      </DetailGroup>
      <AgentControlDialogs agentName={selectionName} control={control} />
    </>
  );
}

function AgentRosterIdentity({ agent }: { agent: ComputerDetailView["agents"][number] }) {
  const display = useLiveAgentDisplay(agent.id) ?? agent.display;
  return (
    <>
      <AgentDisplayAvatar
        agentId={agent.id}
        name={agent.displayName}
        src={agent.avatarUrl}
        display={display}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-primary">{agent.displayName}</span>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-tertiary">
          <RuntimeProviderMark provider={agent.provider} className="size-3.5" />
          <span className="truncate">
            {runtimeProviderLabel(agent.provider)}
            {agent.runtimeConfig.model ? ` · ${agent.runtimeConfig.model}` : ""}
          </span>
        </span>
      </span>
    </>
  );
}
