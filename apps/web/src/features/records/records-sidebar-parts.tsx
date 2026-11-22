import { useRef, type ReactNode } from "react";
import { Focusable } from "react-aria-components";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { Spinner } from "#src/components/ui/spinner";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useEndOfList } from "#src/lib/use-end-of-list";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { recordsTabSearch } from "./records-sidebar";

export function SidebarLoadMore({
  hasMore,
  loading,
  failed,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEndOfList(end, hasMore && !loading && !failed, onLoadMore);
  if (!hasMore) return null;
  return (
    <div ref={end} className="flex items-center justify-center gap-2 py-2 text-xs text-tertiary">
      {failed ? (
        <>
          <span className="text-error-primary">{m.records_sidebar_load_more_error()}</span>
          <Button
            size="xs"
            color="link-gray"
            className="any-pointer-coarse:min-h-11 any-pointer-coarse:px-2"
            onPress={onLoadMore}
          >
            {m.records_sidebar_retry()}
          </Button>
        </>
      ) : loading ? (
        <Spinner className="size-4" />
      ) : null}
    </div>
  );
}

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
      className="mt-0.5 w-full justify-start px-2.5 text-xs text-tertiary any-pointer-coarse:min-h-11"
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
              className={cn(
                "size-4 transition-transform duration-(--duration-sm) ease-in-out motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          }
          className="min-w-0 flex-1 justify-start px-2 text-start text-sm font-medium text-primary any-pointer-coarse:min-h-11"
        >
          <span className="truncate">{title}</span>
          {marker ? (
            <span className="ms-1.5 inline-flex shrink-0 align-middle">{marker}</span>
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
  tooltip,
  className,
  children,
}: {
  recordId: string;
  selected: boolean;
  onSelect: () => void;
  tooltip?: string;
  className?: string;
  children: ReactNode;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const link = (
    <Link
      to="/w/$workspaceSlug/records/$recordId"
      params={{ workspaceSlug, recordId }}
      search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
      aria-current={selected ? "page" : undefined}
      resetScroll={false}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-xl border p-2 text-sm transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand any-pointer-coarse:min-h-11",
        selected
          ? "border-chat-selected-border bg-chat-selected-bg font-medium text-brand-secondary"
          : "border-transparent text-secondary hover:bg-primary_hover",
        className,
      )}
    >
      {children}
    </Link>
  );
  if (!tooltip) return link;
  return (
    <Tooltip title={tooltip} placement="right">
      <Focusable>{link}</Focusable>
    </Tooltip>
  );
}

export function WeekBadge({ week, className }: { week: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-solid text-xs font-semibold text-fg-white",
        className,
      )}
    >
      {week}
    </span>
  );
}
