import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { replaceEqualDeep } from "@tanstack/react-query";
import { Activity as ActivityIcon, ChevronRight } from "@untitledui/icons";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { ClockTime } from "#src/components/ui/relative-time";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ActivityEntry } from "./agent-activity";
import { ACTIVITY_MARKER_CLASS, ActivityMarker } from "./activity-marker";
import {
  presentActivityRows,
  subagentBadgeLabel,
  type PresentedActivityRow,
} from "./agent-activity-presentation";

/** The profile panel's Activity log: one monospace row per entry, each hung on a round marker on
 * a connector line with its clock on the right, oldest at the top, newest at the bottom, the list
 * kept scrolled to the newest row. */
export function AgentActivityTimeline({
  activity,
  timeZone,
}: {
  activity: ActivityEntry[];
  timeZone: string | null;
}) {
  // Each live frame re-presents the whole feed into fresh objects. Handing an unchanged row its
  // previous object back lets `memo` skip it, so a frame re-renders only the rows it added or
  // grew.
  const previous = useRef<Map<string, PresentedActivityRow>>(undefined);
  const rows = useMemo(() => {
    const reusable = previous.current ?? new Map<string, PresentedActivityRow>();
    const next = new Map<string, PresentedActivityRow>();
    const timeline = presentActivityRows(activity).map((presented) => {
      const earlier = reusable.get(presented.key);
      const row = earlier ? replaceEqualDeep(earlier, presented) : presented;
      next.set(row.key, row);
      return row;
    });
    previous.current = next;
    return timeline;
  }, [activity]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const newest = rows.at(-1);
  // Re-runs whenever a row is appended or the newest row grows (a streamed statement merging
  // in another fragment) — the two ways the list can change without an explicit "load more".
  const newestSignal = newest ? `${newest.key}:${newest.detail.length}` : "";
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [newestSignal]);

  if (!rows.length)
    return (
      <Empty className="h-full items-center justify-center px-6 text-center">
        <EmptyHeader className="items-center gap-3">
          <EmptyMedia>
            <ActivityIcon aria-hidden="true" className="size-6 text-tertiary" />
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={2}>
            {m.agent_activity_empty()}
          </EmptyTitle>
          <EmptyDescription>{m.agent_activity_empty_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <ol aria-label="Activity timeline" className="list-none px-5 py-3">
        {rows.map((row) => (
          <ActivityTimelineRow key={row.key} row={row} timeZone={timeZone} />
        ))}
      </ol>
    </div>
  );
}

// Up to 500 frames load per Agent: content-visibility keeps off-screen rows' layout/paint cheap,
// the same trick the file browser uses for its own long lists. The estimate sits between a
// one-line status row (2rem) and a row with its detail on a second line (3.25rem), so the first
// scroll to the newest row lands close before the placeholders resolve.
const ROW_RENDER_COST: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 2.75rem",
};

const ActivityTimelineRow = memo(function ActivityTimelineRow({
  row,
  timeZone,
}: {
  row: PresentedActivityRow;
  timeZone: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const canExpand = row.expandable && row.detail.length > 200;
  const label = canExpand ? (
    <Button
      color="link-gray"
      size="sm"
      className="font-normal text-secondary hover:text-primary"
      aria-expanded={expanded}
      aria-controls={contentId}
      onPress={() => setExpanded(!expanded)}
      iconTrailing={
        <ChevronRight aria-hidden="true" className={cn("size-3", expanded && "rotate-90")} />
      }
    >
      {row.label}
    </Button>
  ) : (
    <span className="text-secondary">{row.label}</span>
  );
  const showDetailBelowLabel = !!row.detail && row.detailOnOwnLine;
  return (
    // The connector runs through the markers' centres (left-1 on a 0.5625rem column; py-1.5 plus
    // the marker's offset puts each centre 1rem down), from the first marker to the last. The
    // marker's ring in the panel's own background masks the line behind it.
    <li
      className="relative grid grid-cols-[0.5625rem_minmax(0,1fr)_auto] gap-x-3 py-1.5 font-mono before:absolute before:inset-y-0 before:left-1 before:border-l before:border-secondary first:before:top-4 last:before:bottom-auto last:before:h-4 only:before:hidden"
      style={ROW_RENDER_COST}
    >
      <ActivityMarker
        tone={row.tone}
        className={cn(ACTIVITY_MARKER_CLASS, "relative z-1 ring-2 ring-bg-primary")}
      />
      <div className="min-w-0">
        <div className="text-sm wrap-anywhere">
          {label}
          {row.subagent && (
            <Badge type="modern" size="sm" color="gray" className="ml-1.5 inline-flex">
              {subagentBadgeLabel(row.subagent)}
            </Badge>
          )}
          {row.detail && !showDetailBelowLabel && (
            <span className="ml-1.5 whitespace-pre-wrap text-tertiary select-text">
              {row.detail}
            </span>
          )}
        </div>
        {showDetailBelowLabel && (
          <p
            id={contentId}
            className={cn(
              "mt-0.5 text-xs text-tertiary select-text",
              row.expandable ? "whitespace-pre-wrap wrap-anywhere" : "break-all",
              canExpand && !expanded && "line-clamp-2",
            )}
          >
            {row.detail}
          </p>
        )}
      </div>
      {/* An absolute HH:MM:SS reads better in a chronological log than "6h ago", which keeps
          shifting as the page stays open; the column takes the clock's own width, so a 12-hour
          clock's "AM" never runs into the row. */}
      <ClockTime
        value={new Date(row.observedAtMs)}
        timeZone={timeZone}
        className="mt-[0.0625rem] text-xs whitespace-nowrap text-quaternary tabular-nums"
      />
    </li>
  );
});
