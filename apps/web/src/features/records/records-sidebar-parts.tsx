import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { recordsTabSearch } from "./records-sidebar";

export function SidebarMore({
  hiddenCount,
  onExpand,
}: {
  hiddenCount: number;
  onExpand: () => void;
}) {
  if (hiddenCount <= 0) return null;
  return (
    <Button
      type="button"
      size="xs"
      color="tertiary"
      onPress={onExpand}
      className="mt-0.5 w-full justify-start px-2.5 text-xs text-tertiary"
    >
      {m.records_sidebar_more({ count: hiddenCount })}
    </Button>
  );
}

export function CollapsibleSection({
  title,
  open,
  onOpenChange,
  marker,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stays on the section title when the list is collapsed. */
  marker?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          color="tertiary"
          aria-expanded={open}
          onPress={() => onOpenChange(!open)}
          iconLeading={
            <ChevronDown
              aria-hidden="true"
              className={cn("size-4 transition-transform", open && "rotate-180")}
            />
          }
          className="min-w-0 flex-1 justify-start px-2 text-left text-sm font-medium text-primary uppercase"
        >
          <span className="truncate">{title}</span>
          {marker ? (
            <span className="ml-1.5 inline-flex shrink-0 align-middle">{marker}</span>
          ) : null}
        </Button>
        {actions}
      </div>
      {open && children}
    </section>
  );
}

export function RecordLink({
  recordId,
  selected,
  onSelect,
  className,
  children,
}: {
  recordId: string;
  selected: boolean;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <Link
      to="/w/$workspaceSlug/records/$recordId"
      params={{ workspaceSlug, recordId }}
      search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
      aria-current={selected ? "page" : undefined}
      resetScroll={false}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-xl border p-2 text-sm transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        selected
          ? "border-chat-selected-border bg-chat-selected-bg font-medium text-brand-secondary"
          : "border-transparent text-secondary hover:bg-primary_hover",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function WeekBadge({ week, className }: { week: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-solid text-xs font-semibold text-white",
        className,
      )}
    >
      {week}
    </span>
  );
}
