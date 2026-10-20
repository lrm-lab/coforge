import { RefreshCw01 as RefreshCw, ChevronDown } from "@untitledui/icons";
import { useHydrated } from "@tanstack/react-router";
import { Disclosure, DisclosurePanel } from "react-aria-components";
import { type RefObject } from "react";

import { type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { TimeMessage, UsageWindow } from "#src/features/computers/runtime-usage";
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

/**
 * The context popover's pure body: everything `useAgentContextReport` fetches, rendered without
 * touching a query client itself, so a test can render it directly with a plain `data` fixture
 * (same split as `RuntimeUsagePopoverContent`, whose bands it follows): the title and Refresh, one
 * usage row for the context window with the composition under it, and when it was read. A
 * failed or missing composition is one short line under the row, never a toast.
 */
export function AgentContextPopoverContent({
  usage,
  data,
  scanning,
  scanFailed = false,
  computerOnline,
  timeZone = null,
  onRefresh,
  refreshButtonWrapRef,
}: {
  /** The reading the Context item shows, so the row says what the item said, before a
   * composition is read and when it cannot be. */
  usage?: { usedTokens: number; windowTokens: number; observedAtMs: number };
  data?: AgentContextPopoverData;
  scanning: boolean;
  scanFailed?: boolean;
  computerOnline?: boolean;
  timeZone?: string | null;
  onRefresh: () => void;
  refreshButtonWrapRef?: RefObject<HTMLSpanElement | null>;
}) {
  const report = data?.result?.report;
  const reading = !data || (data.state === "missing" && (scanning || data.pendingScanId));
  const status = reading
    ? m.agent_context_reading()
    : statusText(data, scanning, computerOnline, scanFailed);
  // The row repeats the reading the Context item that opened it shows, so the two never disagree;
  // the composition's figures stand in only when the popover has no such reading.
  const figures = usage ?? report;
  const readAt = usage ? new Date(usage.observedAtMs) : data?.result?.collectedAt;
  // RelativeTime is blank until hydration; the "Updated" line waits with it, like the runtime
  // usage popover's read time.
  const hydrated = useHydrated();
  const numberFormat = new Intl.NumberFormat(getLocale());

  return (
    <div className="text-sm divide-y divide-secondary">
      <div className="flex items-center gap-3 px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-primary">
          {m.agent_context_title()}
        </h2>
        <span ref={refreshButtonWrapRef} className="shrink-0">
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
        </span>
      </div>

      {(figures || status || data?.state === "stale") && (
        <section className="space-y-3 px-4 py-3">
          {data?.state === "stale" && (
            <p className="text-xs text-warning-primary">
              {scanning ? m.agent_context_stale_refreshing() : m.agent_context_stale()}
            </p>
          )}
          {figures && (
            <UsageWindow
              label={m.agent_context_window()}
              window={{
                usedPercent: contextUsedPercent(figures.usedTokens, figures.windowTokens),
              }}
              note={[
                m.agent_context_tokens_of({
                  tokens: numberFormat.format(figures.usedTokens),
                  window: numberFormat.format(figures.windowTokens),
                }),
                report?.model,
              ]
                .filter(Boolean)
                .join(" · ")}
              timeZone={timeZone}
              resetExpected={false}
            />
          )}
          {status && <p className="text-xs text-tertiary">{status}</p>}
          {report && !reading && <AgentContextReportBody report={report} />}
        </section>
      )}

      {hydrated && readAt && (
        <p className="px-4 py-2 text-xs text-tertiary">
          <TimeMessage
            message={(time) => m.agent_context_updated({ time })}
            value={readAt}
            timeZone={timeZone}
          />
        </p>
      )}
    </div>
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
        <p className={SECTION_LABEL_CLASS}>{m.agent_context_categories()}</p>
        <table className="mt-1.5 w-full text-sm">
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

const SECTION_LABEL_CLASS = "text-xs font-medium text-tertiary";

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
        <DisclosurePanel className="border-t border-secondary p-2">
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
  data: Parameters<typeof AgentContextPopoverContent>[0]["data"],
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
