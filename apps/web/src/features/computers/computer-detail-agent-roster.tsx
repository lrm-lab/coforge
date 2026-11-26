import { useMemo, useState } from "react";
import { Plus } from "@untitledui/icons";
import { Checkbox as AriaCheckbox } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useAppToast } from "#src/components/ui/toast";
import { formatNumber } from "#src/lib/format-number";
import { m } from "#src/paraglide/messages";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { AgentRestartDialog } from "#src/features/agents/agent-control-dialogs";
import {
  useAgentRuntimeControls,
  type AgentControlExecute,
} from "#src/features/agents/agent-runtime-controls";
import {
  BatchAgentRuntimeConfigDialog,
  type BatchRuntimeSaveResult,
} from "#src/features/agents/batch-agent-runtime-config-dialog";
import type { BatchUpdateAgentRuntimeConfigClientInput } from "#src/features/agents/agent.schemas";
import type { RuntimeCatalog, RuntimeOptions } from "#src/features/agents/agent-runtime-fields";
import { runtimeOptionsFromRuntimes } from "#src/features/agents/agent-runtime-options";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { AgentStatusMarker } from "#src/features/agents/agent-status-marker";
import { cn } from "#src/lib/utils";
import { DetailGroup } from "./computer-detail-rows";
import type { ComputerDetailView } from "./computer-detail-view";
import { useAgentModelName } from "#src/features/agents/use-agent-model-name";

function formatBatchSaveToastDetail(result: BatchRuntimeSaveResult): string {
  const whenIdle = result.succeeded.filter((item) => item.restart === "when-idle").length;
  const restarted = result.succeeded.filter((item) => item.restart === "published").length;
  const deferred = result.succeeded.filter((item) => item.restart === "deferred").length;
  const parts: string[] = [];
  if (whenIdle > 0) parts.push(m.agent_batch_runtime_toast_when_idle({ count: whenIdle }));
  if (restarted > 0) parts.push(m.agent_batch_runtime_toast_restarted({ count: restarted }));
  if (deferred > 0) parts.push(m.agent_batch_runtime_toast_deferred({ count: deferred }));
  if (result.skipped.length > 0) {
    parts.push(m.agent_batch_runtime_toast_skipped({ count: result.skipped.length }));
  }
  if (result.failed.length > 0) {
    parts.push(m.agent_batch_runtime_toast_partial_failed({ count: result.failed.length }));
  }
  return parts.join(" · ");
}

export function ComputerDetailAgentRoster({
  computerId,
  runtimes,
  agents,
  onCreateAgent,
  onSelectAgent,
  onExecute,
  onLoadRuntimeCatalog,
  onLoadBatchEnvironmentKeys,
  onBatchUpdateRuntimeConfig,
  onBatchRuntimeConfigSaved,
  canFullReset,
  computerOnline,
  computerName,
}: {
  computerId?: string;
  runtimes?: ComputerDetailView["runtimes"];
  agents: ComputerDetailView["agents"];
  onCreateAgent?: () => void;
  onSelectAgent?: (agentId: string) => void;
  onExecute?: AgentControlExecute;
  onLoadRuntimeCatalog?: (computerId: string) => Promise<RuntimeCatalog[]>;
  onLoadBatchEnvironmentKeys?: (agentIds: string[]) => Promise<Record<string, string[]>>;
  onBatchUpdateRuntimeConfig?: (
    input: BatchUpdateAgentRuntimeConfigClientInput,
  ) => Promise<BatchRuntimeSaveResult>;
  onBatchRuntimeConfigSaved?: (result: BatchRuntimeSaveResult) => Promise<void> | void;
  canFullReset: boolean;
  computerOnline: boolean;
  computerName: string;
}) {
  const toast = useAppToast();
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(AGENT_ROSTER_PAGE_SIZE);
  const [busy, setBusy] = useState(false);
  const [batchConfigOpen, setBatchConfigOpen] = useState(false);
  const [failedNames, setFailedNames] = useState<string[]>([]);
  const visibleAgents = agents.slice(0, visibleCount);
  const hiddenCount = Math.max(0, agents.length - visibleAgents.length);
  const selectedAgents = agents.filter((agent) => selectedIds.has(agent.id));
  const editableSelectedCount = selectedAgents.filter((agent) => agent.ownedByCurrentUser).length;
  const canBatchConfig = Boolean(computerId && onLoadRuntimeCatalog && onBatchUpdateRuntimeConfig);
  const baseRuntimeOptions = useMemo(
    () => (runtimes ? runtimeOptionsFromRuntimes(runtimes) : undefined),
    [runtimes],
  );
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
  const locked = busy || control.restartOpen || batchConfigOpen;
  const loadBatchRuntimeOptions = async (id: string): Promise<RuntimeOptions> => {
    const catalogs = await onLoadRuntimeCatalog!(id);
    return {
      providers: baseRuntimeOptions?.providers ?? [],
      unusable: baseRuntimeOptions?.unusable ?? [],
      catalogs,
    };
  };
  return (
    <>
      <DetailGroup
        heading={`${m.computer_agents_on_computer()} (${formatNumber(agents.length)})`}
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
                {(onExecute || canBatchConfig) && agents.length > 0 && (
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
            <span className="me-auto text-sm tabular-nums text-tertiary">
              {m.computer_agents_selected({ count: formatNumber(selectedAgents.length) })}
            </span>
            {onExecute && (
              <>
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={locked}
                  onPress={() => control.submitStart()}
                >
                  {m.agent_control_start()}
                </Button>
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={locked}
                  onPress={control.submitStop}
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
              </>
            )}
            {canBatchConfig && (
              <Button
                size="sm"
                color="secondary"
                isDisabled={locked || editableSelectedCount === 0}
                onPress={() => setBatchConfigOpen(true)}
              >
                {m.agent_batch_runtime_button()}
              </Button>
            )}
          </div>
        )}
        {failedNames.length > 0 && (
          <p role="alert" className="py-2 text-sm text-error-primary">
            {m.computer_agents_control_failed({ names: failedNames.join(", ") })}
          </p>
        )}
        {control.startDeferred && <p className="py-2 text-sm text-tertiary">{control.startNote}</p>}
        {agents.length ? (
          <div className={cn(ROSTER_COLUMNS, "@2xl:grid")}>
            <div
              aria-hidden="true"
              className={cn(
                ROSTER_ROW,
                "hidden pb-2 text-xs text-tertiary",
                selecting && ROSTER_SELECT_INSET,
              )}
            >
              <span>{m.computer_agents_column_name()}</span>
              <span>{m.computer_agents_column_runtime()}</span>
              <span>{m.computer_agents_column_status()}</span>
            </div>
            <ul className={cn(ROSTER_ROW, "divide-y divide-secondary border-y border-secondary")}>
              {visibleAgents.map((agent) => {
                const toggle = (selected: boolean) =>
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (selected) next.add(agent.id);
                    else next.delete(agent.id);
                    return next;
                  });
                return (
                  <li key={agent.id} className={ROSTER_ROW}>
                    <AgentRosterEntry
                      agent={agent}
                      selecting={selecting}
                      selected={selectedIds.has(agent.id)}
                      locked={locked}
                      onToggle={toggle}
                      onSelectAgent={onSelectAgent}
                    />
                  </li>
                );
              })}
            </ul>
            {hiddenCount > 0 ? (
              <div className="pt-2 @2xl:col-span-3">
                <Button
                  type="button"
                  size="sm"
                  color="secondary"
                  onPress={() => setVisibleCount((count) => count + AGENT_ROSTER_PAGE_SIZE)}
                >
                  {m.computer_detail_show_more({ remaining: formatNumber(hiddenCount) })}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="py-2 text-sm text-tertiary">{m.computer_no_agents_on_computer()}</p>
        )}
      </DetailGroup>
      <AgentRestartDialog agentName={selectionName} control={control} />
      {canBatchConfig && computerId && (
        <BatchAgentRuntimeConfigDialog
          open={batchConfigOpen}
          onOpenChange={setBatchConfigOpen}
          computerId={computerId}
          computerOnline={computerOnline}
          agents={selectedAgents.map((agent) => ({
            id: agent.id,
            displayName: agent.displayName,
            ownedByCurrentUser: agent.ownedByCurrentUser ?? false,
            stopped: agent.stopped ?? false,
            hasApiKey: agent.hasApiKey ?? false,
            provider: agent.provider,
            runtimeConfig: agent.runtimeConfig,
            runtimeConfigInvalid: agent.runtimeConfigInvalid,
          }))}
          onLoadRuntimeOptions={loadBatchRuntimeOptions}
          onLoadEnvironmentKeys={onLoadBatchEnvironmentKeys}
          onSubmitBatch={onBatchUpdateRuntimeConfig!}
          onSaved={(result) => {
            if (result.succeeded.length > 0) {
              const title = m.agent_batch_runtime_toast_saved({ count: result.succeeded.length });
              const detail = formatBatchSaveToastDetail(result);
              toast.success(detail ? `${title} · ${detail}` : title);
            }
            if (result.failed.length === 0) {
              setSelecting(false);
              setSelectedIds(new Set());
            } else {
              const succeededIds = new Set(result.succeeded.map((item) => item.agentId));
              setSelectedIds(
                (current) => new Set([...current].filter((id) => !succeededIds.has(id))),
              );
            }
            void onBatchRuntimeConfigSaved?.(result);
          }}
        />
      )}
    </>
  );
}

function AgentRosterEntry({
  agent,
  selecting,
  selected,
  locked,
  onToggle,
  onSelectAgent,
}: {
  agent: ComputerDetailView["agents"][number];
  selecting: boolean;
  selected: boolean;
  locked: boolean;
  onToggle: (selected: boolean) => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  const display = useLiveAgentDisplay(agent.id) ?? agent.display;
  const status = agentDisplay(display);
  const modelLabel = useAgentModelName(agent.id, agent.runtimeConfig?.model ?? "");
  const identity = (
    <AgentRosterIdentity agent={agent} display={display} status={status} modelLabel={modelLabel} />
  );
  if (selecting)
    return (
      <AriaCheckbox
        aria-label={m.computer_agent_select_named({ name: agent.displayName })}
        isDisabled={locked}
        isSelected={selected}
        onChange={onToggle}
        className={cn(
          ROSTER_ROW,
          ROSTER_SELECT_INSET,
          "relative flex w-full cursor-pointer items-start gap-3 py-3 text-sm hover:bg-primary_hover disabled:cursor-not-allowed",
        )}
      >
        {({ isSelected, isDisabled, isFocusVisible }) => (
          <>
            <span className="absolute inset-s-0 top-4 flex">
              <CheckboxBase
                isSelected={isSelected}
                isDisabled={isDisabled}
                isFocusVisible={isFocusVisible}
              />
            </span>
            {identity}
          </>
        )}
      </AriaCheckbox>
    );
  if (!onSelectAgent)
    return <span className={cn(ROSTER_ROW, "block w-full py-3 text-sm")}>{identity}</span>;
  const rowTooltipDescription = modelLabel ? `@${agent.name} · ${modelLabel}` : `@${agent.name}`;
  return (
    <Tooltip title={agent.displayName} description={rowTooltipDescription}>
      <Button
        noTextPadding
        color="tertiary"
        size="sm"
        onPress={() => onSelectAgent(agent.id)}
        className={cn(
          ROSTER_ROW,
          "h-auto w-full justify-start rounded-none px-0 py-3 text-start font-normal *:data-text:w-full *:data-text:min-w-0",
          "@2xl:*:data-text:col-span-3 @2xl:*:data-text:grid @2xl:*:data-text:grid-cols-subgrid",
        )}
      >
        {identity}
      </Button>
    </Tooltip>
  );
}

const AGENT_ROSTER_PAGE_SIZE = 50;
const ROSTER_COLUMNS =
  "@2xl:grid-cols-[fit-content(33%)_fit-content(32%)_minmax(12rem,1fr)] @2xl:gap-x-4";
const ROSTER_ROW = "@2xl:col-span-3 @2xl:grid @2xl:grid-cols-subgrid @2xl:gap-x-4";
const ROSTER_SELECT_INSET = "ps-7";

function AgentRosterIdentity({
  agent,
  display,
  status,
  modelLabel,
}: {
  agent: ComputerDetailView["agents"][number];
  display: ComputerDetailView["agents"][number]["display"];
  status: ReturnType<typeof agentDisplay>;
  modelLabel: string | undefined;
}) {
  const hasErrorDetail = status.kind === "error" || Boolean(status.alert);
  const runtime = agent.provider ? (
    <>
      <RuntimeProviderMark provider={agent.provider} className="size-3.5 shrink-0" />
      <span className="shrink-0">{runtimeProviderLabel(agent.provider)}</span>
      {modelLabel && <span className="min-w-0 truncate text-tertiary">{modelLabel}</span>}
    </>
  ) : agent.runtimeConfigInvalid ? (
    <span className="truncate text-destructive-primary">{m.agent_profile_runtime_invalid()}</span>
  ) : null;
  return (
    <span className={cn(ROSTER_ROW, "flex w-full min-w-0 items-start")}>
      <span className="flex min-w-0 flex-1 items-start gap-3">
        <AgentDisplayAvatar
          agentId={agent.id}
          name={agent.displayName}
          src={agent.avatarUrl}
          display={display}
          cornerDot={false}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-primary">
            <bdi>{agent.displayName}</bdi>
          </span>
          <span dir="ltr" className="block truncate text-start text-xs text-tertiary">
            @{agent.name}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary @2xl:hidden">
            {runtime}
          </span>
          {hasErrorDetail && (
            <span
              aria-hidden="true"
              className="mt-0.5 block text-xs whitespace-normal wrap-anywhere text-error-primary @2xl:hidden"
            >
              {status.label}
            </span>
          )}
        </span>
      </span>
      <span className="hidden min-w-0 items-center gap-1.5 text-sm text-secondary @2xl:mt-0.5 @2xl:flex">
        {runtime}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-start gap-1.5 text-sm @2xl:mt-0.5",
          status.alert ? "text-error-primary" : "shrink-0 text-secondary",
        )}
      >
        <span className={cn("flex shrink-0", status.alert ? "mt-0.5" : "mt-1.5")}>
          <AgentStatusMarker status={status} className="size-2" />
        </span>
        <span
          className={cn(
            "@max-2xl:sr-only min-w-0",
            hasErrorDetail ? "whitespace-normal wrap-anywhere" : "truncate",
          )}
        >
          {status.label}
        </span>
      </span>
    </span>
  );
}
