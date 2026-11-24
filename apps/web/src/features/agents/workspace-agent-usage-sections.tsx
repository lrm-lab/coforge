import { Link, useNavigate } from "@tanstack/react-router";

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
import type { WorkspaceAgentUsageRow } from "./workspace-agent-usage-model";

export const USAGE_TABLE_GRID_CLASS =
  "@2xl/members:grid @2xl/members:grid-cols-[minmax(12rem,1fr)_7.5rem_6rem] @2xl/members:gap-3 @4xl/members:grid-cols-[minmax(14rem,1.4fr)_7.5rem_6rem_10.5rem_9.5rem]";

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
