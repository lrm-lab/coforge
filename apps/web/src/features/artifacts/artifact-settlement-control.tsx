import { CheckCircle, Circle, RefreshCcw01 } from "@untitledui/icons";
import { Button as AriaButton, Focusable } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { SECTION_LABEL_CLASS } from "#src/features/conversations/review-chrome";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import {
  formatSettledTime,
  type ArtifactSettledView,
  type ArtifactSettlementState,
} from "./use-artifact-settlement";

type SettledRecord = NonNullable<ArtifactSettledView>;

const SETTLED_PILL_SURFACE =
  "bg-utility-green-50 text-utility-green-700 ring-1 ring-utility-green-200 ring-inset";

function useSettledLine() {
  const locale = getLocale();
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return (record: SettledRecord) =>
    m.av_settled_line({
      name: record.by.name,
      time: formatSettledTime(record.at, { locale, timeZone, timeFormat }),
      version: record.version,
    });
}

export function SettledBadge({
  label,
  settled,
  tooltipPlacement = "top",
  className,
}: {
  label: string;
  settled?: SettledRecord | null;
  tooltipPlacement?: "top" | "bottom";
  className?: string;
}) {
  const settledLine = useSettledLine();
  const detail = settled ? settledLine(settled) : undefined;
  const badge = (
    <span
      data-artifact-settled-badge=""
      tabIndex={detail ? 0 : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium",
        detail && "relative z-10 cursor-default outline-focus-ring focus-visible:outline-2",
        SETTLED_PILL_SURFACE,
        className,
      )}
    >
      <CheckCircle aria-hidden="true" className="size-3 shrink-0 text-utility-green-500" />
      <span>{label}</span>
      {detail && <span className="sr-only">{m.av_settled_badge_detail({ line: detail })}</span>}
    </span>
  );
  if (!detail) return badge;
  return (
    <Tooltip title={detail} placement={tooltipPlacement}>
      <Focusable>{badge}</Focusable>
    </Tooltip>
  );
}

export function ArtifactSettlementDetailsSection({
  settlement,
}: {
  settlement: ArtifactSettlementState;
}) {
  const { settled, reopened, canSettle, pending } = settlement;
  const settledLine = useSettledLine();
  const state = settled ? "settled" : reopened ? "reopened" : "working";

  return (
    <section data-artifact-details-status="" className="flex flex-col gap-1.5 p-3">
      <span className={cn(SECTION_LABEL_CLASS, "px-1")}>{m.av_details_status()}</span>
      <div
        data-artifact-details-status-body=""
        data-state={state}
        className="flex min-w-0 flex-col items-start gap-1.5 px-1"
      >
        {canSettle ? (
          <AriaButton
            data-artifact-details-settle=""
            data-settle={settled ? "unsettle" : "settle"}
            aria-busy={pending || undefined}
            isPending={pending}
            onPress={() => {
              if (!pending) void (settled ? settlement.unsettle() : settlement.settle());
            }}
            className={cn(
              "group/status relative inline-grid h-7 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs font-medium outline-focus-ring transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 data-[pending]:pointer-events-none any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-x-1 any-pointer-coarse:after:-inset-y-2",
              settled
                ? pending
                  ? "bg-secondary text-secondary ring-1 ring-secondary ring-inset"
                  : cn(
                      SETTLED_PILL_SURFACE,
                      "hover:bg-secondary hover:text-secondary hover:ring-secondary focus-visible:bg-secondary focus-visible:text-secondary focus-visible:ring-secondary",
                    )
                : pending
                  ? SETTLED_PILL_SURFACE
                  : "bg-secondary text-secondary ring-1 ring-secondary ring-inset hover:bg-utility-green-50 hover:text-utility-green-700 hover:ring-utility-green-200 focus-visible:bg-utility-green-50 focus-visible:text-utility-green-700 focus-visible:ring-utility-green-200",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "col-start-1 row-start-1 inline-flex items-center justify-center gap-1 whitespace-nowrap transition-opacity duration-150",
                pending
                  ? "opacity-0"
                  : "group-hover/status:opacity-0 group-focus-visible/status:opacity-0",
              )}
            >
              {settled ? (
                <CheckCircle
                  aria-hidden="true"
                  className="size-3 shrink-0 text-utility-green-500"
                />
              ) : (
                <Circle aria-hidden="true" className="size-3 shrink-0 text-fg-quaternary" />
              )}
              <span>{settled ? m.av_settled_badge() : m.av_details_working()}</span>
            </span>
            <span
              className={cn(
                "col-start-1 row-start-1 inline-flex items-center justify-center gap-1 whitespace-nowrap transition-opacity duration-150",
                pending
                  ? "opacity-100"
                  : "opacity-0 group-hover/status:opacity-100 group-focus-visible/status:opacity-100",
              )}
            >
              {pending ? (
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
                />
              ) : settled ? (
                <RefreshCcw01 aria-hidden="true" className="size-3 shrink-0" />
              ) : (
                <CheckCircle
                  aria-hidden="true"
                  className="size-3 shrink-0 text-utility-green-500"
                />
              )}
              <span>{settled ? m.av_unsettle_action() : m.av_settle_action()}</span>
            </span>
          </AriaButton>
        ) : settled ? (
          <SettledBadge label={m.av_settled_badge()} />
        ) : (
          <span className="inline-flex h-7 items-center gap-1 rounded-md bg-secondary px-2 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset">
            <Circle aria-hidden="true" className="size-3 shrink-0 text-fg-quaternary" />
            <span>{m.av_details_working()}</span>
          </span>
        )}
        {settled ? (
          <p className="text-xs leading-relaxed text-quaternary [overflow-wrap:anywhere]">
            {settledLine(settled)}
          </p>
        ) : reopened ? (
          <p
            data-artifact-details-reopened=""
            className="text-xs leading-relaxed text-quaternary [overflow-wrap:anywhere]"
          >
            {m.av_reopened_line({
              version: reopened.version,
              was: settledLine(reopened.was),
            })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
