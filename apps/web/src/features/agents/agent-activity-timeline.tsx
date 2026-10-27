import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { replaceEqualDeep } from "@tanstack/react-query";
import { Activity as ActivityIcon, ChevronRight } from "@untitledui/icons";
import { AGENT_ACTIVITY_DETAIL_KIND, type AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
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
import { ConversationBottomPin } from "#src/features/conversations/conversation-bottom-pin";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { ActivityEntry } from "./agent-activity";
import { ACTIVITY_MARKER_CLASS, ActivityMarker } from "./activity-marker";
import { ModelResponseWait } from "./model-response-wait";
import {
  presentActivityRows,
  subagentBadgeLabel,
  type PresentedActivityRow,
} from "./agent-activity-presentation";

/** The profile panel's Activity log: one monospace row per entry, each hung on a round marker on
 * a connector line with its clock on the right, oldest at the top, newest at the bottom, the list
 * kept on the newest row while the reader is there. */
export function AgentActivityTimeline({
  activity,
  display,
  timeZone,
}: {
  activity: ActivityEntry[];
  display?: AgentDisplaySnapshot;
  timeZone: string | null;
}) {
  // Each live frame re-presents the whole feed into fresh objects. Handing an unchanged row its
  // previous object back lets `memo` skip it, so a frame re-renders only the rows it added or
  // grew.
  const previous = useRef<Map<string, PresentedActivityRow>>(undefined);
  const locale = getLocale();
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
  }, [activity, locale]);
  const observations = useMemo(
    () =>
      new Map<string, { entry: ActivityEntry; index: number }>(
        activity.map(
          (entry, index) => [`${entry.launchId}:${entry.clientSeq}:0`, { entry, index }] as const,
        ),
      ),
    [activity],
  );

  // Opens on the newest row and stays there while the list grows (rows appended, a streamed row
  // growing, a row wrapping once it renders past its content-visibility estimate) until the reader
  // scrolls up; scrolling back to the bottom follows again. Same pin as a conversation's history.
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [bottomPin] = useState(() => new ConversationBottomPin());
  const following = useRef(true);
  const empty = rows.length === 0;
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // A list that (re)appears opens on its newest row, whatever an earlier one was scrolled to.
    following.current = true;
    bottomPin.pin(container, "instant");
    // Judged from where the reader stood before this resize: the callback runs after layout.
    const observer = new ResizeObserver(() => {
      const wasAtBottom = bottomPin.beforeResize(container);
      if (following.current && wasAtBottom) bottomPin.pin(container, "instant");
    });
    observer.observe(container);
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [bottomPin, empty]);
  function trackReadingPosition() {
    const container = scrollRef.current;
    if (!container) return;
    const distance = bottomPin.scroll(container);
    // The conversation history's "near enough to follow" distance.
    if (distance !== undefined) following.current = distance <= 48;
  }

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
    <div
      ref={scrollRef}
      onScroll={trackReadingPosition}
      onWheel={bottomPin.read}
      onTouchMove={bottomPin.read}
      onPointerDown={bottomPin.read}
      onKeyDown={bottomPin.read}
      className="h-full overflow-y-auto"
    >
      <ol ref={listRef} aria-label="Activity timeline" className="list-none px-5 py-3">
        {rows.map((row) => {
          const observation = observations.get(row.key);
          const entry = observation?.entry;
          const entryIndex = observation?.index ?? -1;
          const waiting =
            entry?.detailKind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED &&
            entry.detail === "Waiting for model response";
          // This is elapsed history, never a source of current Agent state. Only the cloud
          // display authorizes a live clock; missing history yields a label without timing.
          const next = waiting
            ? activity
                .slice(0, entryIndex)
                .reverse()
                .find(
                  (candidate) =>
                    candidate.launchId === entry.launchId &&
                    candidate.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED &&
                    candidate.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
                )
            : undefined;
          const expiresAt =
            waiting &&
            entryIndex === 0 &&
            display?.activityKind === "working" &&
            display.detailKind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED
              ? (display.expiresAt ?? undefined)
              : undefined;
          return (
            <ActivityTimelineRow
              key={row.key}
              row={row}
              timeZone={timeZone}
              modelWait={
                waiting
                  ? { startedAtMs: entry.observedAtMs, endedAtMs: next?.observedAtMs, expiresAt }
                  : undefined
              }
            />
          );
        })}
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
  modelWait,
}: {
  row: PresentedActivityRow;
  timeZone: string | null;
  modelWait?: { startedAtMs: number; endedAtMs?: number; expiresAt?: number };
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
          {modelWait && <ModelResponseWait {...modelWait} />}
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
