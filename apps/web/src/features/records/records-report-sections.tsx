import { useMemo } from "react";

import { UnreadDot } from "#src/components/ui/unread-marker";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { RecordsCatalog } from "./records-layout";
import { sidebarPreview } from "./records-sidebar";
import { CollapsibleSection, RecordLink, SidebarMore } from "./records-sidebar-parts";

export function RecordsFavoritesSection({
  items,
  showAll,
  onShowAll,
  selectedRecordId,
  open,
  onOpenChange,
  onSelect,
}: {
  items: RecordsCatalog["favorites"];
  showAll: boolean;
  onShowAll: () => void;
  selectedRecordId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: () => void;
}) {
  const preview = useMemo(() => sidebarPreview(items, showAll), [items, showAll]);
  return (
    <CollapsibleSection
      title={m.records_section_favorites()}
      open={open}
      onOpenChange={onOpenChange}
    >
      <ul className="space-y-0.5">
        {preview.visible.map((item) => (
          <li key={item.id}>
            <RecordLink
              recordId={item.id}
              selected={item.id === selectedRecordId}
              onSelect={onSelect}
            >
              <ActorAvatar
                presence={false}
                size="sm"
                name={item.author.displayName}
                alt={item.author.displayName}
                src={item.author.avatarUrl}
              />
              <span className="truncate">
                <bdi>{item.title}</bdi>
              </span>
            </RecordLink>
          </li>
        ))}
      </ul>
      <SidebarMore hiddenCount={preview.hiddenCount} onExpand={onShowAll} />
    </CollapsibleSection>
  );
}

export function RecordsMyReportsSection({
  items,
  me,
  unread,
  selectedRecordId,
  open,
  onOpenChange,
  onSelect,
}: {
  items: RecordsCatalog["myReports"];
  me: { displayName: string; avatarUrl: string | null };
  unread: boolean;
  selectedRecordId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: () => void;
}) {
  return (
    <CollapsibleSection
      title={m.records_section_mine()}
      open={open}
      onOpenChange={onOpenChange}
      marker={
        unread ? (
          <span role="img" aria-label={m.records_report_unread_badge()}>
            <UnreadDot />
          </span>
        ) : null
      }
    >
      <ul className="space-y-0.5">
        {items.map((item) => {
          const sent = item.status === "submitted";
          return (
            <li key={item.id}>
              <RecordLink
                recordId={item.id}
                selected={item.id === selectedRecordId}
                onSelect={onSelect}
                className={cn(item.unread && "font-semibold")}
              >
                <ActorAvatar
                  presence={false}
                  size="sm"
                  name={me.displayName}
                  alt={me.displayName}
                  src={me.avatarUrl ?? undefined}
                />
                <span className="min-w-0 flex-1 truncate">
                  <bdi>{item.title}</bdi>
                </span>
                {sent ? (
                  <span className="ms-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-tertiary">
                    {m.records_report_sent_badge()}
                  </span>
                ) : item.unread ? (
                  <span role="img" aria-label={m.records_report_unread_badge()} className="ms-auto">
                    <UnreadDot />
                  </span>
                ) : null}
              </RecordLink>
            </li>
          );
        })}
      </ul>
    </CollapsibleSection>
  );
}
