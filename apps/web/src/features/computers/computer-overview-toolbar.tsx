import { useRef } from "react";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { ArrowUp, FilterLines, Grid01, List, Plus, SearchLg } from "@untitledui/icons";
import {
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Input } from "#src/components/base/input/input";
import { Select, type SelectItemType } from "#src/components/base/select/select";
import { CountBadge } from "#src/components/ui/unread-marker";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
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
  onBatchUpgrade: () => void;
  onAdd: () => void;
  compact: boolean;
};

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
  onBatchUpgrade,
  onAdd,
  compact,
}: ComputerOverviewToolbarProps) {
  const dialogRef = useRef<HTMLElement>(null);

  const activeCount =
    Number(status !== "all") +
    Number(runtime !== "all") +
    Number(groupBy !== "none") +
    Number(sortBy !== "attention");

  const statusItems: SelectItemType[] = [
    { id: "all", label: m.computer_overview_status_all() },
    { id: "online", label: m.computer_overview_status_online() },
    { id: "offline", label: m.computer_overview_status_offline() },
    { id: "attention", label: m.computer_overview_status_attention() },
  ];

  const runtimeItems: SelectItemType[] = [
    { id: "all", label: m.computer_overview_runtime_all() },
    ...runtimeOptions.map((provider) => ({
      id: provider,
      label: runtimeProviderLabel(provider),
      icon: <RuntimeProviderMark provider={provider} className="size-4" />,
    })),
    ...(hasOtherRuntime ? [{ id: "other", label: m.computer_overview_runtime_other() }] : []),
  ];

  const groupItems: SelectItemType[] = [
    { id: "none", label: m.computer_overview_group_none() },
    { id: "owner", label: m.computer_overview_group_owner() },
    { id: "kind", label: m.computer_overview_group_kind() },
    { id: "prefix", label: m.computer_overview_group_prefix() },
  ];

  const sortItems: SelectItemType[] = [
    { id: "attention", label: m.computer_overview_sort_attention() },
    { id: "name", label: m.computer_overview_sort_name() },
    { id: "disk", label: m.computer_overview_sort_disk() },
    { id: "memory", label: m.computer_overview_sort_memory() },
    ...runtimeOptions.map((provider) => ({
      id: `runtime:${provider}`,
      label: m.computer_overview_sort_runtime_left({
        runtime: runtimeProviderLabel(provider),
      }),
      icon: <RuntimeProviderMark provider={provider} className="size-4" />,
    })),
  ];

  const resetAll = () => {
    onStatusChange("all");
    onRuntimeChange("all");
    onGroupByChange("none");
    onSortByChange("attention");
    dialogRef.current?.focus();
  };

  const filterButtonContent = compact ? (
    activeCount > 0 ? (
      <CountBadge count={activeCount} size="sm" />
    ) : null
  ) : (
    <>
      <span>{m.computer_overview_filters_label()}</span>
      {activeCount > 0 ? <CountBadge count={activeCount} size="sm" /> : null}
    </>
  );

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

      <AriaDialogTrigger>
        <Button
          type="button"
          size="sm"
          color="secondary"
          aria-label={compact ? m.computer_overview_filters_label() : undefined}
          iconLeading={FilterLines}
          className={cn(
            "shrink-0 [&>[data-text]]:inline-flex [&>[data-text]]:items-center [&>[data-text]]:gap-1.5",
            activeCount > 0 && "text-brand-secondary ring-brand",
          )}
        >
          {filterButtonContent}
        </Button>
        <AriaPopover
          placement="bottom start"
          offset={6}
          className={cn(
            "w-72 max-w-[calc(100vw-2rem)] origin-(--trigger-anchor-point) rounded-xl bg-primary p-3.5 shadow-lg ring-1 ring-secondary",
            POPOVER_MOTION,
          )}
        >
          <AriaDialog
            ref={dialogRef}
            aria-label={m.computer_overview_filters_label()}
            className="flex flex-col gap-3 outline-hidden"
          >
            <Select
              size="sm"
              label={m.computer_overview_status_label()}
              selectedKey={status}
              onSelectionChange={(key) =>
                onStatusChange(String(key) as ComputerOverviewStatusFilter)
              }
              items={statusItems}
            >
              {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>

            <Select
              size="sm"
              label={m.computer_overview_runtime_label()}
              selectedKey={runtime}
              onSelectionChange={(key) =>
                onRuntimeChange(String(key) as ComputerOverviewRuntimeFilter)
              }
              items={runtimeItems}
            >
              {(item) => (
                <Select.Item id={item.id} icon={item.icon}>
                  {item.label}
                </Select.Item>
              )}
            </Select>

            <Select
              size="sm"
              label={m.computer_overview_group_label()}
              selectedKey={groupBy}
              onSelectionChange={(key) => onGroupByChange(String(key) as ComputerOverviewGroupBy)}
              items={groupItems}
            >
              {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>

            <Select
              size="sm"
              label={m.computer_overview_sort_label()}
              selectedKey={sortBy}
              onSelectionChange={(key) => onSortByChange(String(key) as ComputerOverviewSortBy)}
              items={sortItems}
            >
              {(item) => (
                <Select.Item id={item.id} icon={item.icon}>
                  {item.label}
                </Select.Item>
              )}
            </Select>

            {activeCount > 0 ? (
              <div className="flex justify-end border-t border-secondary pt-2">
                <Button type="button" size="xs" color="link-gray" onPress={resetAll}>
                  {m.computer_overview_clear_filters()}
                </Button>
              </div>
            ) : null}
          </AriaDialog>
        </AriaPopover>
      </AriaDialogTrigger>

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
