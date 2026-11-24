import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import {
  ArrowUp,
  ChevronDown,
  CpuChip01,
  Grid01,
  LayersThree01,
  List,
  Plus,
  SearchLg,
  Sliders04,
  SwitchVertical01,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ComputersOverviewLayout } from "./computer-overview-layout";
import type {
  ComputerOverviewGroupBy,
  ComputerOverviewRuntimeFilter,
  ComputerOverviewSortBy,
  ComputerOverviewStatusFilter,
} from "./computer-overview-model";

export type ComputerOverviewToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  status: ComputerOverviewStatusFilter;
  onStatusChange: (status: ComputerOverviewStatusFilter) => void;
  runtime: ComputerOverviewRuntimeFilter;
  onRuntimeChange: (runtime: ComputerOverviewRuntimeFilter) => void;
  runtimeOptions: readonly RuntimeProvider[];
  hasOtherRuntime: boolean;
  groupBy: ComputerOverviewGroupBy;
  onGroupByChange: (groupBy: ComputerOverviewGroupBy) => void;
  sortBy: ComputerOverviewSortBy;
  onSortByChange: (sortBy: ComputerOverviewSortBy) => void;
  layout: ComputersOverviewLayout;
  onLayoutChange: (layout: ComputersOverviewLayout) => void;
  batchUpgradeCount: number;
  upgradingCount?: number;
  onBatchUpgrade: () => void;
  onAdd: () => void;
  compact: boolean;
};

function statusLabel(status: ComputerOverviewStatusFilter): string {
  switch (status) {
    case "online":
      return m.computer_overview_status_online();
    case "offline":
      return m.computer_overview_status_offline();
    case "attention":
      return m.computer_overview_status_attention();
    default:
      return m.computer_overview_status_all();
  }
}

function runtimeFilterLabel(runtime: ComputerOverviewRuntimeFilter): string {
  if (runtime === "all") return m.computer_overview_runtime_all();
  if (runtime === "other") return m.computer_overview_runtime_other();
  return runtimeProviderLabel(runtime);
}

function groupByLabel(groupBy: ComputerOverviewGroupBy): string {
  switch (groupBy) {
    case "owner":
      return m.computer_overview_group_owner();
    case "kind":
      return m.computer_overview_group_kind();
    case "prefix":
      return m.computer_overview_group_prefix();
    default:
      return m.computer_overview_group_none();
  }
}

function sortByLabel(sortBy: ComputerOverviewSortBy): string {
  switch (sortBy) {
    case "attention":
      return m.computer_overview_sort_attention();
    case "name":
      return m.computer_overview_sort_name();
    case "disk":
      return m.computer_overview_sort_disk();
    case "memory":
      return m.computer_overview_sort_memory();
    default: {
      const provider = sortBy.slice("runtime:".length) as RuntimeProvider;
      return m.computer_overview_sort_runtime_left({
        runtime: runtimeProviderLabel(provider),
      });
    }
  }
}

export function ComputerOverviewToolbar({
  query,
  onQueryChange,
  status,
  onStatusChange,
  runtime,
  onRuntimeChange,
  runtimeOptions,
  hasOtherRuntime,
  groupBy,
  onGroupByChange,
  sortBy,
  onSortByChange,
  layout,
  onLayoutChange,
  batchUpgradeCount,
  upgradingCount = 0,
  onBatchUpgrade,
  onAdd,
  compact,
}: ComputerOverviewToolbarProps) {
  const statusActive = status !== "all";
  const runtimeActive = runtime !== "all";
  const groupActive = groupBy !== "none";
  const sortActive = sortBy !== "attention";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-secondary bg-primary px-page py-2.5">
      <div className={cn("min-w-44 flex-1", compact ? "max-w-full" : "sm:max-w-xs")}>
        <Input
          type="search"
          size="sm"
          icon={SearchLg}
          aria-label={m.computer_overview_search_label()}
          placeholder={m.computer_overview_search_placeholder()}
          value={query}
          onChange={onQueryChange}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Dropdown.Root>
          <Button
            type="button"
            size="sm"
            color="secondary"
            aria-label={`${m.computer_overview_status_label()}: ${statusLabel(status)}`}
            iconLeading={Sliders04}
            iconTrailing={ChevronDown}
            className={cn(statusActive && "text-brand-secondary ring-brand")}
          >
            {compact ? null : statusLabel(status)}
          </Button>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              aria-label={m.computer_overview_status_label()}
              selectionMode="single"
              selectedKeys={new Set([status])}
              onAction={(key) => onStatusChange(String(key) as ComputerOverviewStatusFilter)}
            >
              <Dropdown.Item id="all" label={m.computer_overview_status_all()} />
              <Dropdown.Item id="online" label={m.computer_overview_status_online()} />
              <Dropdown.Item id="offline" label={m.computer_overview_status_offline()} />
              <Dropdown.Item id="attention" label={m.computer_overview_status_attention()} />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>

        <Dropdown.Root>
          <Button
            type="button"
            size="sm"
            color="secondary"
            aria-label={`${m.computer_overview_runtime_label()}: ${runtimeFilterLabel(runtime)}`}
            iconLeading={CpuChip01}
            iconTrailing={ChevronDown}
            className={cn(runtimeActive && "text-brand-secondary ring-brand")}
          >
            {compact ? null : runtimeFilterLabel(runtime)}
          </Button>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              aria-label={m.computer_overview_runtime_label()}
              selectionMode="single"
              selectedKeys={new Set([runtime])}
              onAction={(key) => onRuntimeChange(String(key) as ComputerOverviewRuntimeFilter)}
            >
              <Dropdown.Item id="all" label={m.computer_overview_runtime_all()} />
              {runtimeOptions.map((provider) => (
                <Dropdown.Item
                  key={provider}
                  id={provider}
                  label={runtimeProviderLabel(provider)}
                  leading={<RuntimeProviderMark provider={provider} className="size-4" />}
                />
              ))}
              {hasOtherRuntime ? (
                <Dropdown.Item id="other" label={m.computer_overview_runtime_other()} />
              ) : null}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>

        <Dropdown.Root>
          <Button
            type="button"
            size="sm"
            color="secondary"
            aria-label={`${m.computer_overview_group_label()}: ${groupByLabel(groupBy)}`}
            iconLeading={LayersThree01}
            iconTrailing={ChevronDown}
            className={cn(groupActive && "text-brand-secondary ring-brand")}
          >
            {compact ? null : groupByLabel(groupBy)}
          </Button>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              aria-label={m.computer_overview_group_label()}
              selectionMode="single"
              selectedKeys={new Set([groupBy])}
              onAction={(key) => onGroupByChange(String(key) as ComputerOverviewGroupBy)}
            >
              <Dropdown.Item id="none" label={m.computer_overview_group_none()} />
              <Dropdown.Item id="owner" label={m.computer_overview_group_owner()} />
              <Dropdown.Item id="kind" label={m.computer_overview_group_kind()} />
              <Dropdown.Item id="prefix" label={m.computer_overview_group_prefix()} />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>

        <Dropdown.Root>
          <Button
            type="button"
            size="sm"
            color="secondary"
            aria-label={`${m.computer_overview_sort_label()}: ${sortByLabel(sortBy)}`}
            iconLeading={SwitchVertical01}
            iconTrailing={ChevronDown}
            className={cn(sortActive && "text-brand-secondary ring-brand")}
          >
            {compact ? null : sortByLabel(sortBy)}
          </Button>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              aria-label={m.computer_overview_sort_label()}
              selectionMode="single"
              selectedKeys={new Set([sortBy])}
              onAction={(key) => onSortByChange(String(key) as ComputerOverviewSortBy)}
            >
              <Dropdown.Item id="attention" label={m.computer_overview_sort_attention()} />
              <Dropdown.Item id="name" label={m.computer_overview_sort_name()} />
              <Dropdown.Item id="disk" label={m.computer_overview_sort_disk()} />
              <Dropdown.Item id="memory" label={m.computer_overview_sort_memory()} />
              {runtimeOptions.map((provider) => (
                <Dropdown.Item
                  key={provider}
                  id={`runtime:${provider}`}
                  label={m.computer_overview_sort_runtime_left({
                    runtime: runtimeProviderLabel(provider),
                  })}
                  leading={<RuntimeProviderMark provider={provider} className="size-4" />}
                />
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      </div>

      <div className="ms-auto flex shrink-0 items-center gap-2">
        {batchUpgradeCount >= 2 ? (
          <Button
            type="button"
            size="sm"
            color="secondary"
            iconLeading={ArrowUp}
            aria-label={m.computer_upgrade_all_action({ count: batchUpgradeCount })}
            onPress={onBatchUpgrade}
          >
            {compact
              ? String(batchUpgradeCount)
              : m.computer_upgrade_all_action({ count: batchUpgradeCount })}
          </Button>
        ) : upgradingCount >= 2 ? (
          <Button
            type="button"
            size="sm"
            color="secondary"
            isLoading
            showTextWhileLoading
            isDisabled
            aria-label={m.computer_upgrade_running_multiple({ count: String(upgradingCount) })}
          >
            {compact
              ? String(upgradingCount)
              : m.computer_upgrade_running_multiple({ count: String(upgradingCount) })}
          </Button>
        ) : null}

        <ButtonGroup
          size="sm"
          aria-label={m.computer_overview_view_label()}
          disallowEmptySelection
          selectedKeys={new Set([layout])}
          onSelectionChange={(keys) => {
            const first = [...keys][0];
            if (first === "card" || first === "list") onLayoutChange(first);
          }}
        >
          <ButtonGroupItem
            id="card"
            iconLeading={Grid01}
            aria-label={m.computer_overview_view_card()}
          />
          <ButtonGroupItem
            id="list"
            iconLeading={List}
            aria-label={m.computer_overview_view_list()}
          />
        </ButtonGroup>

        <Button
          type="button"
          size="sm"
          color="primary"
          iconLeading={Plus}
          aria-label={m.computer_add_title()}
          onPress={onAdd}
        >
          {compact ? null : <span className="hidden sm:inline">{m.computer_add_title()}</span>}
        </Button>
      </div>
    </div>
  );
}
