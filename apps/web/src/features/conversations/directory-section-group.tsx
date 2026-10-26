import { ChevronRight } from "@untitledui/icons";
import { useId, type FC, type ReactNode } from "react";
import { Button } from "#src/components/base/buttons/button";
import { cx } from "#src/utils/cx";
import type { DirectoryDragActivation } from "./directory-drag";

/** Every row, title and list in the directory shares one inset, so a title's chevron, the Saved
 * entry's bookmark and a channel row's avatar all start on the same x: 0.75rem here plus the
 * 0.5rem a row pads itself by is the 1.25rem the design asks for. */
export const DIRECTORY_INSET = "px-3";

/**
 * A sidebar group's title and its rows. A group that can collapse (Channels, Direct messages)
 * makes the whole caption its toggle, like Slack's sidebar sections, and draws a chevron in the
 * leading 20px gutter. A group that cannot (Pinned, per the design mockup) draws its own mark in
 * that same gutter instead, so every title in the list keeps the same x either way.
 */
/** The line an expanded section shows when it has no conversations. One 2.25rem row, so the
 * next title sits 36px below this one. */
export function DirectoryEmptyNote({ children }: { children: ReactNode }) {
  return (
    <li className="flex h-9 items-center px-2 text-xs text-quaternary">
      <span className="truncate">{children}</span>
    </li>
  );
}

export function DirectorySection({
  label,
  count,
  empty,
  icon: Icon,
  expanded,
  onToggle,
  action,
  headingProps,
  wrapTitle,
  children,
}: {
  label: string;
  /** Conversations in this section, including zero. Stays beside the title when the section is folded. */
  count: number;
  /** Nothing to list: the body is the empty note alone, without the avatar-to-title padding. */
  empty?: boolean;
  /** A non-collapsible section's own mark, in the gutter a collapsible one gives its chevron —
   * the way the Saved entry carries a bookmark. Ignored on a collapsible section: the mockup
   * gives Channels and Direct messages a chevron and no second mark. */
  icon?: FC<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  expanded?: boolean;
  /** Absent on a section that cannot collapse: its rows are always shown, and its title row is
   * not a control at all, so it draws no chevron and takes no hover highlight. */
  onToggle?: () => void;
  /** Optional trailing control on the header row, e.g. a "+" that creates a channel. It sits
   * outside the toggle button so it is its own click target, not part of collapsing. */
  action?: ReactNode;
  /** The title row's drag activation, when the section can be dragged to a new place. */
  headingProps?: DirectoryDragActivation;
  /** Wraps the title's toggle, e.g. in the section's context menu (`ChatSectionMenu`). */
  wrapTitle?: (toggle: ReactNode) => ReactNode;
  children: ReactNode;
}) {
  const listId = useId();
  const wrap = wrapTitle ?? ((toggle: ReactNode) => toggle);
  // The title carries its own size, weight and colour, so it reads as a title of the list rather
  // than a caption above it (and beats the Button's own `font-semibold`, which belongs to a real
  // button).
  const title = (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="min-w-0 truncate text-sm font-medium text-primary">{label}</span>
      <span className="sr-only">, </span>
      <span className="shrink-0 text-sm font-normal text-quaternary tabular-nums">{count}</span>
    </span>
  );
  return (
    <>
      {/* One unified hover surface for the whole header row: the row itself carries the
          `hover:bg-primary_hover` (like a channel/DM row), and the toggle and the trailing `+`
          are transparent so they never paint a second, differently-shaped highlight. They stay
          independent click targets. `h-9` is the 2.25rem title row the list is built on: with no
          margin between the sections, consecutive titles land exactly 2.25rem apart. */}
      <div className={cx(DIRECTORY_INSET, "group/section")}>
        <div
          className={cx(
            "flex h-9 items-center gap-1 rounded-md pr-2 pl-2 transition-colors duration-100 ease-linear",
            onToggle ? "group-hover/section:bg-primary_hover" : "cursor-pointer",
          )}
        >
          {onToggle ? (
            wrap(
              // The whole caption row is the toggle, and `flex-1` fills the row width, so the hit
              // area is large both ways (the user reported the old target was too small);
              // `justify-start pl-0` puts the chevron on the same x as a row's own icon.
              <Button
                {...headingProps}
                color="tertiary"
                size="sm"
                aria-expanded={expanded}
                aria-controls={listId}
                onPress={onToggle}
                className="min-w-0 flex-1 justify-start pr-2 pl-0 hover:bg-transparent! [&_[data-text]]:min-w-0 [&_[data-text]]:flex-1 [&_[data-text]]:text-left"
                iconLeading={
                  <ChevronRight
                    aria-hidden="true"
                    className={cx(
                      "size-4 shrink-0 transition-transform duration-100 ease-linear",
                      expanded && "rotate-90",
                    )}
                  />
                }
              >
                {title}
              </Button>,
            )
          ) : (
            // Nothing to press: the mark takes the chevron's gutter and the title keeps its x.
            // The row still uses the hand cursor, the same as the other section titles.
            // `gap-1.5`, not the Button's own `gap-1`: the Button's label span adds 2px of its
            // own, so 6px here is what puts this title on the same x as a collapsible section's
            // (measured in the browser, both at 262px in the 1440 layout).
            <span
              {...headingProps}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2"
            >
              {Icon ? (
                // Same ink as the Saved bookmark: text colour, #101319 in light mode.
                <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
              ) : null}
              {title}
            </span>
          )}
          {action}
        </div>
      </div>
      {/* Kept mounted but hidden: collapsing must not throw away the rows' realtime state. A
          section that cannot collapse still folds while the sections are being reordered. */}
      {/* Design spec: 36px from the last row's avatar to the next section's title. A row pads its
          avatar by 0.5rem and its list item by 1px, so the list adds the 27px left (1.6875rem);
          when the last row is a bordered card (a channel or direct message), its 1px border takes
          one of those (1.625rem). An empty section is the 2.25rem note alone. A folded section
          adds nothing: folded titles stay one 2.25rem row apart. */}
      <div
        id={listId}
        hidden={expanded === false}
        className={
          empty
            ? undefined
            : "pb-[1.6875rem] has-[>div>ul>li:last-child_[data-row-card]]:pb-[1.625rem]"
        }
      >
        {children}
      </div>
    </>
  );
}
