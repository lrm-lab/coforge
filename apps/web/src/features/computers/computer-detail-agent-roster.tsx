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
import { StatusDot } from "#src/components/ui/status-dot";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { cn } from "#src/lib/utils";
import { DetailGroup } from "./computer-detail-rows";
import type { ComputerDetailView } from "./computer-detail-view";
import { useAgentModelName } from "#src/features/agents/use-agent-model-name";

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
          <>
            {/* The table's column heads, set in by a row's checkbox while selecting; below `@2xl` a
                row stacks its runtime under its name and its status is a dot, so there are no
                columns to head. */}
            <div
              aria-hidden="true"
              className={cn(
                ROSTER_COLUMNS,
                "hidden pb-2 text-xs text-tertiary @2xl:grid",
                selecting && ROSTER_SELECT_INSET,
              )}
            >
              <span>{m.computer_agents_column_name()}</span>
              <span>{m.computer_agents_column_runtime()}</span>
              <span>{m.computer_agents_column_status()}</span>
            </div>
            <ul className="divide-y divide-secondary border-y border-secondary">
              {agents.map((agent) => {
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
                        className="relative flex w-full cursor-pointer items-center gap-3 py-3 text-sm hover:bg-primary_hover disabled:cursor-not-allowed"
                      >
                        {({ isSelected, isDisabled, isFocusVisible }) => (
                          <>
                            <CheckboxBase
                              isSelected={isSelected}
                              isDisabled={isDisabled}
                              isFocusVisible={isFocusVisible}
                            />
                            <AgentRosterIdentity agent={agent} />
                          </>
                        )}
                      </AriaCheckbox>
                    ) : onSelectAgent ? (
                      // Otherwise the row itself opens the Agent — no trailing "Open" button to aim
                      // at. Its accessible name is its own content (name, runtime, handle). The
                      // official Button carries the row: `h-auto`/`py-3` keep the table's rhythm,
                      // `rounded-none px-0` keep its cells on the column heads, and `font-normal`
                      // leaves the cells at their own weight instead of the Button's semibold.
                      <Button
                        noTextPadding
                        color="tertiary"
                        size="sm"
                        onPress={() => onSelectAgent(agent.id)}
                        className="h-auto w-full justify-start rounded-none px-0 py-3 text-left font-normal *:data-text:w-full *:data-text:min-w-0"
                      >
                        <AgentRosterIdentity agent={agent} />
                      </Button>
                    ) : (
                      <span className="block w-full py-3 text-sm">
                        <AgentRosterIdentity agent={agent} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="py-2 text-sm text-tertiary">{m.computer_no_agents_on_computer()}</p>
        )}
      </DetailGroup>
      <AgentControlDialogs agentName={selectionName} control={control} />
    </>
  );
}

/** The table's columns, shared by its heads and its rows: name, runtime, status. */
const ROSTER_COLUMNS = "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_9rem] gap-x-4";
/** How far a selecting row's checkbox sets its cells in: the `sm` checkbox (16px) and the row's
 * `gap-3`. The heads move by the same amount to stay over their cells. */
const ROSTER_SELECT_INSET = "pl-7";

/** One Agent's cells: avatar, name and @handle; its runtime and model; its status. Below `@2xl`
 * the runtime stacks under the name and the status is a dot at the row's end, its words for screen
 * readers only. */
function AgentRosterIdentity({ agent }: { agent: ComputerDetailView["agents"][number] }) {
  const display = useLiveAgentDisplay(agent.id) ?? agent.display;
  const modelLabel = useAgentModelName(agent.id, agent.runtimeConfig.model ?? "");
  const status = agentDisplay(display);
  const runtime = (
    <>
      <RuntimeProviderMark provider={agent.provider} className="size-3.5" />
      <span className="truncate">
        {runtimeProviderLabel(agent.provider)}
        {modelLabel ? ` · ${modelLabel}` : ""}
      </span>
    </>
  );
  return (
    <span className={cn(ROSTER_COLUMNS, "grid w-full min-w-0 items-center @max-2xl:flex")}>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <AgentDisplayAvatar
          agentId={agent.id}
          name={agent.displayName}
          src={agent.avatarUrl}
          display={display}
          cornerDot={false}
        />
        <span className="min-w-0">
          <span className="block truncate font-medium text-primary">{agent.displayName}</span>
          <span className="block truncate text-xs text-tertiary">@{agent.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary @2xl:hidden">
            {runtime}
          </span>
        </span>
      </span>
      <span className="hidden min-w-0 items-center gap-1.5 text-sm text-secondary @2xl:flex">
        {runtime}
      </span>
      <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-sm text-secondary">
        <StatusDot tone={status.tone} pulse={status.pulse} className="size-2" />
        <span className="truncate @max-2xl:sr-only">{status.label}</span>
      </span>
    </span>
  );
}
