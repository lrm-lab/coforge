import { RefreshCw01 as RefreshCw, ChevronDown } from "@untitledui/icons";
import { useHydrated } from "@tanstack/react-router";
import { Disclosure, DisclosurePanel } from "react-aria-components";

import { type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { TimeMessage, UsageWindow } from "#src/features/computers/usage-window";
import { getLocale } from "#src/paraglide/runtime";
import { m } from "#src/paraglide/messages";

/** Read-only alias for the popover body's `data` shape, re-declared from the hook's return so a
 * test can render this component directly with a plain fixture (no React Query). */
export type AgentContextPopoverData = {
  state: "fresh" | "stale" | "missing";
  result?: {
    scanId: string;
    status: string;
    message?: string;
    report?: {
      provider: RuntimeProvider;
      model?: string;
      usedTokens: number;
      windowTokens: number;
      observedAt: string;
      categories: { name: string; tokens: number; approximate?: boolean }[];
      memoryFiles?: { kind: string; path: string; tokens: number; approximate?: boolean }[];
      skills?: { name: string; source: string; tokens: number; approximate?: boolean }[];
    };
    collectedAt: string;
  };
  pendingScanId?: string;
};

/** The categorical swatches for the stacked bar and table dots (`bg-avatar-1..6`, `lib/
 * avatar-tone.ts`'s palette), plus a neutral for Free space. No red/amber: a category is not a
 * threshold; the context row above them carries the risk colour. */
const CATEGORY_TONES = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
] as const;

/** The share of the context window in use, as a whole percent clamped to 0–100: the Context
 * badge and the popover's row read the same number. */
export function contextUsedPercent(usedTokens: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((usedTokens / windowTokens) * 100)));
}

function isFreeSpace(name: string) {
  return /free\s+space/i.test(name);
}

/** The composition read behind a Claude Code Agent's context: what `useAgentContextReport`
 * returns, passed in as plain props so the section stays a pure body. */
export type AgentContextReportState = {
  data?: AgentContextPopoverData;
  scanning: boolean;
  scanFailed?: boolean;
  onRefresh: () => void;
};

/**
 * The context section of the Runtime usage card (`RuntimeUsage`'s `footer`), a pure body so a test
 * can render it with plain fixtures: one usage row for the context window and when it was read.
 * With a `report` (Claude Code only) a collapsed disclosure holds the composition, its stale and
 * failure lines, and Refresh. A failed or missing composition is one short line, never a toast.
 */
export function AgentContextSection({
  usage,
  report: reportState,
  computerOnline,
  timeZone = null,
}: {
  usage: { usedTokens: number; windowTokens: number; observedAtMs: number };
  report?: AgentContextReportState;
  computerOnline?: boolean;
  timeZone?: string | null;
}) {
  // RelativeTime is blank until hydration; the "Updated" line waits with it, like the runtime
  // usage card's read time.
  const hydrated = useHydrated();
  const numberFormat = new Intl.NumberFormat(getLocale());
  const model = reportState?.data?.result?.report?.model;

  return (
    <div className="space-y-3">
      <div>
        <UsageWindow
          label={m.agent_context_title()}
          window={{
            usedPercent: contextUsedPercent(usage.usedTokens, usage.windowTokens),
          }}
          note={[
            m.agent_context_tokens_of({
              tokens: numberFormat.format(usage.usedTokens),
              window: numberFormat.format(usage.windowTokens),
            }),
            model,
          ]
            .filter(Boolean)
            .join(" · ")}
          timeZone={timeZone}
          resetExpected={false}
        />
        {hydrated && (
          <p className="mt-1 text-xs text-tertiary">
            <TimeMessage
              message={(time) => m.agent_context_updated({ time })}
              value={new Date(usage.observedAtMs)}
              timeZone={timeZone}
            />
          </p>
        )}
      </div>
      {reportState && <AgentContextComposition {...reportState} computerOnline={computerOnline} />}
    </div>
  );
}

function AgentContextComposition({
  data,
  scanning,
  scanFailed = false,
  computerOnline,
  onRefresh,
}: AgentContextReportState & { computerOnline?: boolean }) {
  const report = data?.result?.report;
  const reading = !data || (data.state === "missing" && (scanning || data.pendingScanId));
  const status = reading
    ? m.agent_context_reading()
    : statusText(data, scanning, computerOnline, scanFailed);

  return (
    <Disclosure className="rounded-lg border border-secondary">
      <Button
        slot="trigger"
        type="button"
        color="tertiary"
        size="sm"
        className="w-full justify-between"
        iconTrailing={ChevronDown}
      >
        {m.agent_context_categories()}
      </Button>
      {/* The panel stays in the DOM while collapsed (`hidden="until-found"` keeps its box), so
          its padding and rule live on an inner wrapper. */}
      <DisclosurePanel>
        <div className="space-y-3 border-t border-secondary p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              {data?.state === "stale" && (
                <p className="text-xs text-warning-primary">
                  {scanning ? m.agent_context_stale_refreshing() : m.agent_context_stale()}
                </p>
              )}
              {status && <p className="text-xs text-tertiary">{status}</p>}
            </div>
            {/* React Aria's isPending keeps focus through a refresh, so the peek survives it;
                isDisabled only for a Computer known offline. No Tooltip: PreviewTrigger shares the
                one-open-tooltip-at-a-time state, and a tooltip inside the peek closes the peek. */}
            <Button
              type="button"
              size="xs"
              color="tertiary"
              aria-label={m.agent_context_refresh()}
              isLoading={scanning}
              isDisabled={computerOnline === false}
              iconLeading={RefreshCw}
              className="shrink-0"
              onPress={onRefresh}
            />
          </div>
          {report && !reading && <AgentContextReportBody report={report} />}
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

type PopoverReport = NonNullable<NonNullable<AgentContextPopoverData["result"]>["report"]>;

function AgentContextReportBody({ report }: { report: PopoverReport }) {
  const numberFormat = new Intl.NumberFormat(getLocale());
  const percent = (tokens: number) => contextUsedPercent(tokens, report.windowTokens);
  return (
    <div>
      <StackedCategoryBar report={report} />
      <div className="mt-3">
        <table className="w-full text-sm">
          <tbody>
            {report.categories.map((category) => (
              <tr key={category.name} className="border-b border-secondary last:border-b-0">
                <td className="py-1.5 pr-2 align-middle">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        isFreeSpace(category.name)
                          ? "bg-secondary-solid"
                          : categoryTone(report.categories, category.name),
                      )}
                    />
                    <span className="truncate text-primary">{category.name}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-tertiary">
                  {numberFormat.format(category.tokens)}
                  {category.approximate ? "~" : ""}
                </td>
                <td className="py-1.5 text-right tabular-nums text-tertiary">
                  {percent(category.tokens)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.memoryFiles && report.memoryFiles.length > 0 && (
        <ItemList
          label={m.agent_context_memory_files()}
          items={report.memoryFiles.map((file) => ({
            key: `${file.kind}:${file.path}`,
            title: file.path,
            subtitle: file.kind,
            tokens: file.tokens,
            approximate: file.approximate === true,
          }))}
          numberFormat={numberFormat}
        />
      )}
      {report.skills && report.skills.length > 0 && (
        <ItemList
          label={m.agent_context_skills()}
          items={report.skills.map((skill) => ({
            key: `${skill.name}:${skill.source}`,
            title: skill.name,
            subtitle: skill.source,
            tokens: skill.tokens,
            approximate: skill.approximate === true,
          }))}
          numberFormat={numberFormat}
        />
      )}
    </div>
  );
}

function StackedCategoryBar({ report }: { report: PopoverReport }) {
  const categories = report.categories;
  const total = categories.reduce((sum, category) => sum + category.tokens, 0) || 1;
  return (
    <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-secondary">
      {categories.map((category) => (
        <div
          key={category.name}
          className={cn(
            "h-full",
            isFreeSpace(category.name)
              ? "bg-secondary-solid"
              : categoryTone(categories, category.name),
          )}
          style={{ width: `${(category.tokens / total) * 100}%` }}
          role="presentation"
        />
      ))}
    </div>
  );
}

function ItemList({
  label,
  items,
  numberFormat,
}: {
  label: string;
  items: { key: string; title: string; subtitle: string; tokens: number; approximate: boolean }[];
  numberFormat: Intl.NumberFormat;
}) {
  return (
    <div className="mt-3">
      <Disclosure className="rounded-lg border border-secondary">
        <Button
          slot="trigger"
          type="button"
          color="tertiary"
          size="sm"
          className="w-full justify-between"
          iconTrailing={ChevronDown}
        >
          {label} · {items.length}
        </Button>
        <DisclosurePanel>
          <div className="border-t border-secondary p-2">
            <ul className="divide-y divide-secondary">
              {items.map((item) => (
                <li
                  key={item.key}
                  className="flex min-w-0 items-baseline justify-between gap-3 py-1.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs text-primary">
                      {item.title}
                    </span>
                    <span className="block truncate text-xs text-tertiary">{item.subtitle}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-tertiary">
                    {numberFormat.format(item.tokens)}
                    {item.approximate ? "~" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </DisclosurePanel>
      </Disclosure>
    </div>
  );
}

function categoryTone(categories: { name: string }[], name: string): string {
  const index = categories.findIndex((category) => category.name === name);
  return CATEGORY_TONE_AT(index);
}

/** Deterministic categorical tone for one category, Free space excluded by the caller. */
function CATEGORY_TONE_AT(index: number): string {
  return CATEGORY_TONES[index % CATEGORY_TONES.length]!;
}

function statusText(
  data: AgentContextPopoverData | undefined,
  scanning: boolean,
  computerOnline: boolean | undefined,
  scanFailed: boolean,
): string | undefined {
  if (scanning) return m.agent_context_scanning();
  if (computerOnline === false) return m.agent_profile_computer_offline();
  if (scanFailed) return m.agent_context_no_response();
  return data?.result && !data.result.report
    ? contextFailureDescription(data.result.status)
    : undefined;
}

function contextFailureDescription(status: string): string {
  if (status === "unsupported") return m.agent_context_status_unsupported();
  if (status === "no_session") return m.agent_context_status_no_session();
  if (status === "unparsed") return m.agent_context_status_unparsed();
  if (status === "timeout") return m.agent_context_status_timeout();
  if (status === "error") return m.agent_context_status_error();
  return m.agent_context_status_error();
}
