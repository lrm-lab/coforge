import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { loadRecordsCatalog } from "./records.functions";
import { recordsTabSearch } from "./records-sidebar";
import {
  formatSendWindowCountdown,
  isWeeklySendArmed,
  isWeeklyTemplateChipHighlighted,
  weeklySendWindow,
} from "./weekly-send-window";

type FormatChip = Awaited<ReturnType<typeof loadRecordsCatalog>>["formatChips"][number];

export function FormatChipSlot({
  chip,
  distinguishSettingsName,
  selected,
  onSelect,
}: {
  chip: FormatChip;
  distinguishSettingsName: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const [now, setNow] = useState(() => new Date());
  const appliedSchedule = chip.appliedSchedule;
  const alreadySent = chip.alreadySent;

  useEffect(() => {
    if (!chip.interactive || !appliedSchedule) return;
    const timer = window.setInterval(() => {
      const next = new Date();
      setNow(next);
      const windowRange = weeklySendWindow({
        now: next,
        sendWeekday: appliedSchedule.sendWeekday,
        sendTime: appliedSchedule.sendTime,
        scheduleEnabled: appliedSchedule.scheduleEnabled,
      });
      if (windowRange && next.getTime() >= windowRange.end.getTime()) {
        window.clearInterval(timer);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [chip.interactive, appliedSchedule]);

  const scheduleInput =
    chip.interactive && appliedSchedule
      ? {
          applied: true as const,
          alreadySent,
          sendWeekday: appliedSchedule.sendWeekday,
          sendTime: appliedSchedule.sendTime,
          scheduleEnabled: appliedSchedule.scheduleEnabled,
          autoSendCancelled: chip.autoSendCancelled,
          now,
        }
      : null;
  const sendArmed = scheduleInput ? isWeeklySendArmed(scheduleInput) : false;
  const highlighted = scheduleInput ? isWeeklyTemplateChipHighlighted(scheduleInput) : false;

  const windowRange =
    sendArmed && appliedSchedule
      ? weeklySendWindow({
          now,
          sendWeekday: appliedSchedule.sendWeekday,
          sendTime: appliedSchedule.sendTime,
          scheduleEnabled: appliedSchedule.scheduleEnabled,
        })
      : null;
  const remainingMs = windowRange ? Math.max(0, windowRange.end.getTime() - now.getTime()) : 0;

  const weekLabel = m.records_current_week_template({
    year: chip.year,
    week: chip.week,
  });
  const chipTitle =
    distinguishSettingsName && chip.name.trim() && chip.name.trim() !== weekLabel
      ? `${weekLabel} · ${chip.name.trim()}`
      : weekLabel;

  const label = (
    <>
      <span className="truncate">{chipTitle}</span>
      {alreadySent ? (
        <span className="ml-auto shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-tertiary">
          {m.records_report_sent_badge()}
        </span>
      ) : sendArmed ? (
        <span className="shrink-0 tabular-nums">{formatSendWindowCountdown(remainingMs)}</span>
      ) : null}
    </>
  );

  const chipClassName = cn(
    "flex min-h-9 w-full items-center gap-2 rounded-xl border px-2 py-2 text-sm font-medium transition-colors",
    highlighted
      ? "border-transparent bg-brand-primary text-brand-secondary"
      : "border-transparent text-secondary",
    chip.interactive && !highlighted && "hover:bg-primary_hover",
    !chip.interactive && "cursor-not-allowed opacity-60",
    selected && "border-chat-selected-border bg-chat-selected-bg text-brand-secondary",
  );

  if (!chip.interactive || !chip.id) {
    return (
      <div
        role="status"
        aria-disabled="true"
        aria-label={m.records_current_week_template_disabled()}
        className={chipClassName}
      >
        {label}
      </div>
    );
  }

  return (
    <Link
      to="/w/$workspaceSlug/records/$recordId"
      params={{ workspaceSlug, recordId: chip.id }}
      search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
      aria-current={selected ? "page" : undefined}
      resetScroll={false}
      onClick={onSelect}
      className={cn(
        chipClassName,
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
      )}
    >
      {label}
    </Link>
  );
}
