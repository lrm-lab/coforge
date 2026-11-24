import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronDown, ChevronSelectorVertical } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatNumber } from "#src/lib/format-number";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

import { AgentDisplayAvatar } from "./agent-display-avatar";
import { DELETED_AGENT_NAME_CLASS, DeletedAgentLabel } from "./deleted-agent";
import {
  formatCompactTokens,
  formatExactTokens,
  formatUsagePercent,
  type AgentTokenUsageModelShare,
} from "./agent-token-usage-model";
import { formatAgentProfileParam } from "./profile-panel/profile-panel-search";
import { useAgentModelName } from "./use-agent-model-name";
import { useLiveAgentDisplay } from "./workspace-agents-realtime";
import type {
  WorkspaceAgentUsageRow,
  WorkspaceAgentUsageSort,
  WorkspaceAgentUsageSortKey,
} from "./workspace-agent-usage-model";

export const USAGE_TABLE_GRID_CLASS =
  "@2xl/members:grid @2xl/members:grid-cols-[minmax(12rem,1fr)_7.5rem_6rem] @2xl/members:gap-3 @4xl/members:grid-cols-[minmax(14rem,1.4fr)_7.5rem_6rem_10.5rem_9.5rem]";

type UsageSortColumnSpec = Readonly<{
  key: WorkspaceAgentUsageSortKey;
  label: () => string;
  align: "start" | "end";
  wideOnly?: boolean;
}>;

const USAGE_SORT_COLUMNS: readonly UsageSortColumnSpec[] = [
  { key: "agent", label: m.member_table_col_agent, align: "start" },
  { key: "tokens", label: m.agent_usage_col_tokens, align: "end" },
  { key: "turns", label: m.agent_usage_col_turns, align: "end" },
  { key: "model", label: m.agent_usage_col_model, align: "start", wideOnly: true },
  { key: "owner", label: m.member_table_col_owner, align: "start", wideOnly: true },
];

const COARSE_HIT_TARGET_CLASS =
  "relative any-pointer-coarse:after:absolute any-pointer-coarse:after:top-1/2 any-pointer-coarse:after:left-1/2 any-pointer-coarse:after:size-full any-pointer-coarse:after:min-h-11 any-pointer-coarse:after:min-w-11 any-pointer-coarse:after:-translate-x-1/2 any-pointer-coarse:after:-translate-y-1/2";

function isUsageSortKey(value: string): value is WorkspaceAgentUsageSortKey {
  return (
    value === "agent" ||
    value === "tokens" ||
    value === "turns" ||
    value === "model" ||
    value === "owner"
  );
}

function formatSortAriaLabel(
  columnLabel: string,
  active: boolean,
  direction: WorkspaceAgentUsageSort["direction"],
): string {
  if (!active) return m.agent_usage_sort_by({ column: columnLabel });
  return direction === "asc"
    ? m.agent_usage_sort_active_asc({ column: columnLabel })
    : m.agent_usage_sort_active_desc({ column: columnLabel });
}

export function UsageRankingHeader({
  sort,
  onSort,
}: {
  sort: WorkspaceAgentUsageSort;
  onSort: (key: WorkspaceAgentUsageSortKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label={m.agent_usage_sort_label()}
      className={cn(
        "hidden border-b border-secondary px-4 py-2 text-xs text-tertiary",
        USAGE_TABLE_GRID_CLASS,
      )}
    >
      {USAGE_SORT_COLUMNS.map((column) => {
        const active = sort.key === column.key;
        const label = column.label();
        const SortIcon = active
          ? sort.direction === "asc"
            ? ArrowUp
            : ArrowDown
          : ChevronSelectorVertical;

        return (
          <div
            key={column.key}
            className={cn(
              "flex min-w-0 items-center",
              column.align === "end" ? "justify-end" : "justify-start",
              column.wideOnly && "hidden @4xl/members:flex",
            )}
          >
            <AriaButton
              onPress={() => onSort(column.key)}
              aria-pressed={active}
              aria-label={formatSortAriaLabel(label, active, sort.direction)}
              className={cn(
                "group inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 whitespace-nowrap outline-none transition-colors data-focus-visible:ring-2 data-focus-visible:ring-brand",
                COARSE_HIT_TARGET_CLASS,
                column.align === "end" ? "-me-1 flex-row-reverse text-end" : "-ms-1 text-start",
                active
                  ? "font-semibold text-primary"
                  : "font-medium text-tertiary hover:text-primary",
              )}
            >
              <span className="truncate">{label}</span>
              <SortIcon
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 transition-colors",
                  active
                    ? "text-primary"
                    : "text-fg-quaternary opacity-60 group-hover:text-tertiary group-hover:opacity-100",
                )}
              />
            </AriaButton>
          </div>
        );
      })}
    </div>
  );
}

export function UsageRankingSortMenu({
  sort,
  onSort,
}: {
  sort: WorkspaceAgentUsageSort;
  onSort: (key: WorkspaceAgentUsageSortKey) => void;
}) {
  const activeColumn =
    USAGE_SORT_COLUMNS.find((column) => column.key === sort.key) ?? USAGE_SORT_COLUMNS[1]!;
  const activeLabel = activeColumn.label();
  const DirectionIcon = sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <div className="@2xl/members:hidden">
      <Dropdown.Root>
        <Button
          size="xs"
          color="secondary"
          iconLeading={DirectionIcon}
          iconTrailing={ChevronDown}
          aria-label={`${m.agent_usage_sort_label()}: ${formatSortAriaLabel(activeLabel, true, sort.direction)}`}
          className={cn("text-xs font-medium", COARSE_HIT_TARGET_CLASS)}
        >
          {activeLabel}
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={m.agent_usage_sort_label()}
            selectionMode="single"
            selectedKeys={new Set([sort.key])}
            onAction={(key) => {
              const next = String(key);
              if (isUsageSortKey(next)) onSort(next);
            }}
          >
            {USAGE_SORT_COLUMNS.map((column) => {
              const active = sort.key === column.key;
              return (
                <Dropdown.Item
                  key={column.key}
                  id={column.key}
                  label={column.label()}
                  addon={
                    active
                      ? sort.direction === "asc"
                        ? m.agent_usage_sort_asc()
                        : m.agent_usage_sort_desc()
                      : undefined
                  }
                />
              );
            })}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}

const MODEL_SWATCH_CLASSES = [
  "bg-chart-input",
  "bg-chart-output",
  "bg-chart-cache",
  "bg-quaternary",
] as const;

export function ModelDistributionStrip({
  models,
  locale,
}: {
  models: readonly AgentTokenUsageModelShare[];
  locale: string;
}) {
  const nonZero = models.filter((entry) => entry.effectiveTokens > 0);
  if (nonZero.length === 0) return null;

  return (
    <div className="border-t border-secondary px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-tertiary">
          {m.agent_usage_team_models_heading()}
        </span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {nonZero.slice(0, 4).map((entry, index) => (
            <span
              key={`${entry.provider}:${entry.model}`}
              className="inline-flex items-center gap-1.5 text-secondary tabular-nums"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  MODEL_SWATCH_CLASSES[index % MODEL_SWATCH_CLASSES.length],
                )}
              />
              <span className="max-w-40 truncate font-mono text-primary">
                {entry.model || m.agent_usage_model_unknown()}
              </span>
              <span className="text-tertiary">
                {formatUsagePercent(entry.sharePercent, locale)}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="mt-2.5 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-secondary">
        {nonZero.slice(0, 4).map((entry, index) => (
          <span
            key={`${entry.provider}:${entry.model}`}
            className={cn(
              "block h-full min-w-1 rounded-xs",
              MODEL_SWATCH_CLASSES[index % MODEL_SWATCH_CLASSES.length],
            )}
            style={{ width: `${entry.sharePercent}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function UsageRow({
  row,
  selected,
  locale,
}: {
  row: WorkspaceAgentUsageRow;
  selected: boolean;
  locale: string;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate();
  const display = useLiveAgentDisplay(row.agentId);
  const resolvedModel = useAgentModelName(row.agentId, row.topModel);
  const shareLabel =
    row.effectiveTokens > 0
      ? m.agent_usage_team_share({ percent: formatUsagePercent(row.teamSharePercent, locale) })
      : m.agent_usage_no_usage_short();
  const hoverDetail =
    row.effectiveTokens > 0
      ? m.agent_usage_hover_detail({
          exact: formatExactTokens(row.effectiveTokens, locale),
          newInput: formatCompactTokens(row.newInputTokens, locale),
          output: formatCompactTokens(row.outputTokens, locale),
        })
      : undefined;

  function openUsageProfile() {
    void navigate({
      to: "/w/$workspaceSlug/members",
      params: { workspaceSlug },
      resetScroll: false,
      search: (previous) => ({
        ...previous,
        profile: formatAgentProfileParam(row.agentId),
        agentTab: row.archived ? "profile" : "usage",
      }),
    });
  }

  return (
    <li
      className={cn(
        "relative flex min-w-0 cursor-pointer flex-col gap-2 px-4 py-3 transition-colors hover:bg-primary_hover @2xl/members:items-center",
        USAGE_TABLE_GRID_CLASS,
        selected && "bg-chat-selected-bg",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <AgentDisplayAvatar
          agentId={row.agentId}
          name={row.displayName}
          src={row.avatarUrl}
          display={row.archived ? undefined : display}
          deleted={row.archived}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <h3
                className={cn(
                  "min-w-0 truncate text-sm font-semibold",
                  row.archived ? DELETED_AGENT_NAME_CLASS : "text-primary",
                )}
              >
                <Link
                  to="/w/$workspaceSlug/members"
                  params={{ workspaceSlug }}
                  resetScroll={false}
                  search={(previous) => ({
                    ...previous,
                    profile: formatAgentProfileParam(row.agentId),
                    agentTab: row.archived ? "profile" : "usage",
                  })}
                  onClick={(event) => {
                    const rowEl =
                      event.currentTarget.closest<HTMLElement>("li") ?? event.currentTarget;
                    rememberSharedRect("member-profile-origin", rowEl);
                  }}
                  aria-label={m.agent_open_profile({ name: row.displayName })}
                  aria-current={selected ? "page" : undefined}
                  className="rounded-sm outline-focus-ring outline-offset-4 after:absolute after:inset-0 focus-visible:outline-2"
                >
                  {row.displayName}
                </Link>
              </h3>
              {row.archived && <DeletedAgentLabel />}
            </div>
            <span className="shrink-0 text-sm font-semibold text-primary tabular-nums @2xl/members:hidden">
              {formatCompactTokens(row.effectiveTokens, locale)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-tertiary @2xl/members:hidden">
            {row.effectiveTokens > 0 && <span className="tabular-nums">{shareLabel}</span>}
            <span className="tabular-nums">
              {m.agent_usage_team_summary_turns({ turns: formatNumber(row.turns, locale) })}
            </span>
            {resolvedModel && <span className="truncate font-mono">{resolvedModel}</span>}
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 justify-end @2xl/members:flex">
        <Tooltip title={shareLabel} description={hoverDetail} delay={120} placement="top">
          <TooltipTrigger
            onPress={openUsageProfile}
            className="relative z-10 cursor-pointer rounded-sm px-1.5 py-0.5 text-end text-sm font-semibold text-primary tabular-nums outline-focus-ring transition-colors hover:bg-secondary focus-visible:outline-2"
          >
            {formatCompactTokens(row.effectiveTokens, locale)}
          </TooltipTrigger>
        </Tooltip>
      </div>

      <div className="hidden min-w-0 truncate text-end text-xs text-secondary tabular-nums @2xl/members:block">
        {formatNumber(row.turns, locale)}
      </div>

      <div className="hidden min-w-0 truncate font-mono text-xs text-tertiary @4xl/members:block">
        {resolvedModel || "—"}
      </div>

      <div className="hidden min-w-0 items-center gap-2 text-xs text-tertiary @4xl/members:flex">
        <ActorAvatar
          presence={false}
          size="xs"
          userId={row.ownerId}
          name={row.ownerDisplayName}
          src={row.ownerAvatarUrl}
        />
        <span dir="auto" className="min-w-0 truncate">
          {row.ownerDisplayName}
        </span>
      </div>
    </li>
  );
}
