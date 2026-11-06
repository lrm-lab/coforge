import { type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useDroppable } from "@dnd-kit/core";
import { Check, ChevronDown, DotsHorizontal, EyeOff, Plus } from "@untitledui/icons";
import { useEffect, useState, type ReactNode } from "react";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  HIDDEN_COLUMN_CLASS,
  isTaskColumnHidden,
} from "#src/features/settings/task-hidden-columns";
import { dropTargetClass, type DropState } from "./task-drop-target";
import { TaskStatusIcon, statusLabel } from "./task-status-icon";

/**
 * A group whose Tasks the caller reads in pages rather than holding them all: its header shows
 * `count` (every Task in the group, not only the loaded ones), `onExpandedChange` says when it
 * opens so its first page is read only then, and `footer` goes under its loaded cards.
 */
export type PagedTaskGroup = {
  count: number;
  onExpandedChange: (expanded: boolean) => void;
  footer: ReactNode;
};

/** How many cards a group shows at first, and how many more "Show more" adds: a group of
 * hundreds would otherwise build every card, handle and menu at once. */
const RENDER_PAGE = 50;

export function TaskGroup({
  status,
  count,
  loaded,
  board,
  dropState,
  paged,
  hidable,
  onHide,
  onAdd,
  onSortByPriority,
  sortedByPriority,
  children,
}: {
  status: TaskStatus;
  /** A board column the viewer can hide: before hydration it follows the stored choice by CSS,
   * and a hidden paged column never reads its pages. */
  hidable?: boolean;
  /** Hides this board column; given, the column header has a menu offering it. */
  onHide?: () => void;
  /** Starts a new Task in this column; given, the board header has a "+" and a menu entry. */
  onAdd?: () => void;
  /** Sets or clears the column's by-priority order; given, the column menu offers it. */
  onSortByPriority?: (on: boolean) => void;
  sortedByPriority?: boolean;
  /** Every Task in the group; for a paged group, more than those read. */
  count: number;
  /** The cards the group holds now. */
  loaded: number;
  board: boolean;
  dropState: DropState;
  paged?: PagedTaskGroup;
  /** The group's first `shown` cards. */
  children: (shown: number) => ReactNode;
}) {
  // A collapsed group stays a drop target, so a card can still be moved into it.
  const drop = useDroppable({ id: status, disabled: dropState !== "open" });
  const label = statusLabel(status);
  // Every group starts open; its header collapses it for as long as the board is shown.
  const [expanded, setExpanded] = useState(true);
  const onExpandedChange = paged?.onExpandedChange;
  // A paged group reads its Tasks only while open, including when it starts open.
  useEffect(() => {
    // Mounted while hydrating although the viewer hid it (the render cannot know yet): no read.
    if (hidable && isTaskColumnHidden(status)) return;
    onExpandedChange?.(expanded);
    // A group that leaves the board (another status picked) stops reading too.
    return () => onExpandedChange?.(false);
  }, [onExpandedChange, expanded, hidable, status]);
  // A group renders its cards in pages. A paged group is already read in pages no longer than
  // one render page, so it renders every card it has read and keeps to its own footer.
  const [shown, setShown] = useState(RENDER_PAGE);
  const hidden = paged ? 0 : loaded - shown;
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={label}
      data-drop-blocked={dropState === "blocked" || undefined}
      className={
        board
          ? cn(
              "flex min-w-0 flex-col rounded-xl bg-secondary md:max-w-80 md:min-w-52 md:flex-1",
              hidable && HIDDEN_COLUMN_CLASS[status],
              !expanded && "md:self-start",
              dropTargetClass(dropState, drop.isOver),
            )
          : cn(
              "min-w-0 overflow-hidden rounded-xl border border-secondary bg-primary",
              dropTargetClass(dropState, drop.isOver),
            )
      }
    >
      <Disclosure
        isExpanded={expanded}
        onExpandedChange={setExpanded}
        className={board ? "flex min-h-0 flex-1 flex-col" : undefined}
      >
        <div
          className={cn(
            "flex items-center",
            board ? "shrink-0 pr-1" : cn("bg-secondary", expanded && "border-b border-secondary"),
          )}
        >
          <Heading level={2} className="min-w-0 flex-1">
            <AriaButton
              slot="trigger"
              aria-label={`${label} ${count}`}
              className={cn(
                "flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 text-sm font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2",
                board ? "rounded-xl px-3" : "px-4",
              )}
            >
              <TaskStatusIcon status={status} />
              <span className="truncate">{label}</span>
              <span className="font-medium text-quaternary tabular-nums">{count}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "ml-auto size-4 shrink-0 text-fg-quaternary transition-transform",
                  // A board column at desktop width gives the room to its title; clicking the
                  // heading still folds it, and a folded column is plainly short.
                  board && "md:hidden",
                  !expanded && "-rotate-90",
                )}
              />
            </AriaButton>
          </Heading>
          {/* "+" and "···" sit beside the heading, not in it, so the heading names the column alone. */}
          {board && onAdd && (
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={Plus}
              tooltip={m.task_board_add_to({ status: label })}
              aria-label={m.task_board_add_to({ status: label })}
              onClick={onAdd}
            />
          )}
          {(onHide || (board && (onAdd || onSortByPriority))) && (
            <Dropdown.Root>
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.tasks_column_menu({ status: label })}
              />
              <Dropdown.Popover placement="bottom end" className="w-48">
                <Dropdown.Menu aria-label={m.tasks_column_menu({ status: label })}>
                  {board && onSortByPriority && (
                    <Dropdown.Item
                      icon={sortedByPriority ? Check : undefined}
                      label={m.task_board_sort_priority()}
                      onAction={() => onSortByPriority(!sortedByPriority)}
                    />
                  )}
                  {board && onAdd && (
                    <Dropdown.Item icon={Plus} label={m.task_board_add_here()} onAction={onAdd} />
                  )}
                  {onHide && (
                    <Dropdown.Item icon={EyeOff} label={m.tasks_hide_column()} onAction={onHide} />
                  )}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          )}
        </div>
        <DisclosurePanel
          // A collapsed panel is `hidden="until-found"`, which Tailwind's preflight leaves displayed: hide it outright.
          className={cn(
            board
              ? "flex min-h-16 flex-col gap-2 px-2 pb-2 md:min-h-0 md:flex-1 md:overflow-y-auto"
              : "flex flex-col divide-y divide-secondary",
            !expanded && "hidden",
          )}
        >
          {/* The panel keeps its children mounted while hidden; a collapsed group renders none. */}
          {expanded && children(paged ? loaded : shown)}
          {expanded && hidden > 0 && (
            <div className={cn("flex", board ? "justify-center" : "justify-start px-4 py-2")}>
              <Button
                size="sm"
                color="link-gray"
                onPress={() => setShown((current) => current + RENDER_PAGE)}
              >
                {m.tasks_group_show_more({ count: String(Math.min(hidden, RENDER_PAGE)) })}
              </Button>
            </div>
          )}
          {expanded && paged?.footer}
          {expanded && !paged && !board && count === 0 && (
            <p className="px-4 py-3 text-sm text-tertiary">{m.tasks_group_empty()}</p>
          )}
        </DisclosurePanel>
      </Disclosure>
    </section>
  );
}

/** A hidden board column: its name and count, a drop target still, and pressing it shows the
 * column again. */
export function HiddenColumn({
  status,
  count,
  dropState,
  onShow,
}: {
  status: TaskStatus;
  count: number;
  dropState: DropState;
  onShow: () => void;
}) {
  const drop = useDroppable({ id: status, disabled: dropState !== "open" });
  const label = statusLabel(status);
  return (
    <AriaButton
      ref={drop.setNodeRef}
      aria-label={m.tasks_show_column({ status: label, count: String(count) })}
      onPress={onShow}
      data-drop-blocked={dropState === "blocked" || undefined}
      className={({ isFocusVisible, isHovered }) =>
        cn(
          "flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-secondary bg-primary px-3 text-sm text-secondary outline-focus-ring transition-[background-color]",
          isHovered && "bg-primary_hover",
          isFocusVisible && "outline-2 outline-offset-2",
          dropTargetClass(dropState, drop.isOver),
        )
      }
    >
      <TaskStatusIcon status={status} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="text-quaternary tabular-nums">{count}</span>
    </AriaButton>
  );
}
