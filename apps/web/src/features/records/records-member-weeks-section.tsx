import { useMemo } from "react";
import { ChevronDown } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { RecordsCatalog } from "./records-layout";
import {
  CollapsibleSection,
  RecordLink,
  SidebarLoadMore,
  SidebarMore,
  WeekBadge,
} from "./records-sidebar-parts";
import { defaultMemberWeekExpanded } from "./records-sidebar-expand";
import { sidebarPreview } from "./records-sidebar";

type MemberWeek = RecordsCatalog["memberWeeks"][number] & { key: string };

/** "Member weekly reports" sidebar section: week rows with their expandable submissions. */
export function RecordsMemberWeeksSection({
  weeks,
  people,
  hasMore,
  loadingMore,
  loadFailed,
  onLoadMore,
  query,
  selectedRecordId,
  selectedWeekKey,
  expandedWeeks,
  onExpandedWeekChange,
  showAll,
  onShowAll,
  open,
  onOpenChange,
  onSelect,
}: {
  /** Weeks already filtered by `query`. */
  weeks: MemberWeek[];
  /** Who the submissions name, by `authorId`. */
  people: RecordsCatalog["people"];
  /** Older weeks are still to be read (`onLoadMore`), once every week read so far is listed. */
  hasMore: boolean;
  loadingMore: boolean;
  loadFailed: boolean;
  onLoadMore: () => void;
  query: string;
  selectedRecordId?: string;
  selectedWeekKey?: string;
  /** Per-week toggles chosen by the user; weeks without an entry use the default. */
  expandedWeeks: Record<string, boolean>;
  onExpandedWeekChange: (weekKey: string, expanded: boolean) => void;
  /** Every week listed, not only the first few; kept by the layout across tab switches. */
  showAll: boolean;
  onShowAll: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: () => void;
}) {
  const preview = useMemo(
    () => sidebarPreview(weeks, Boolean(query) || showAll),
    [weeks, query, showAll],
  );

  return (
    <CollapsibleSection title={m.records_section_members()} open={open} onOpenChange={onOpenChange}>
      {weeks.length === 0 ? null : (
        <ul className="space-y-1">
          {preview.visible.map((week) => {
            const hasSubmissions = week.submissions.length > 0;
            const weekSelected =
              selectedWeekKey === week.key ||
              week.overviewReportId === selectedRecordId ||
              week.submissions.some((item) => item.id === selectedRecordId);
            const expanded =
              expandedWeeks[week.key] ??
              defaultMemberWeekExpanded({
                year: week.year,
                week: week.week,
                weekSelected,
                hasSubmissions,
                queryActive: Boolean(query),
              });
            return (
              <li key={week.key} className="space-y-0.5">
                <div className="flex min-w-0 items-center gap-1 rounded-lg">
                  {hasSubmissions ? (
                    <ButtonUtility
                      size="xs"
                      color="tertiary"
                      icon={
                        <ChevronDown
                          aria-hidden="true"
                          data-icon
                          className={cn("size-4 transition-transform", expanded && "rotate-180")}
                        />
                      }
                      className="size-7 shrink-0"
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? m.records_collapse_week({ week: week.title })
                          : m.records_expand_week({ week: week.title })
                      }
                      onClick={() => onExpandedWeekChange(week.key, !expanded)}
                    />
                  ) : (
                    <span className="size-7 shrink-0" aria-hidden="true" />
                  )}
                  <RecordLink
                    recordId={week.overviewReportId}
                    selected={weekSelected}
                    onSelect={onSelect}
                    className="min-w-0 flex-1 font-medium"
                  >
                    <WeekBadge week={week.week} className="size-6" />
                    <span className="truncate">{week.title}</span>
                  </RecordLink>
                </div>
                {hasSubmissions && expanded ? (
                  <ul className="ml-7 space-y-0.5">
                    {week.submissions.map((submission) => {
                      const author = people[submission.authorId];
                      return (
                        <li key={submission.id}>
                          <RecordLink
                            recordId={submission.id}
                            selected={submission.id === selectedRecordId}
                            onSelect={onSelect}
                          >
                            <IdentityAvatar
                              size="sm"
                              name={author?.displayName}
                              alt={author?.displayName}
                              src={author?.avatarUrl}
                            />
                            <span className="truncate">{submission.title}</span>
                          </RecordLink>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <SidebarMore hiddenCount={preview.hiddenCount} onExpand={onShowAll} />
      <SidebarLoadMore
        hasMore={hasMore && preview.hiddenCount === 0}
        loading={loadingMore}
        failed={loadFailed}
        onLoadMore={onLoadMore}
      />
    </CollapsibleSection>
  );
}
