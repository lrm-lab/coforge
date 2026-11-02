import type { ComponentType, SVGProps } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";

/** A bar across the top of a tab (Activity's diagnostics, Chat's heading): one height, so an
 * empty state under it can sit where it sits in a tab without one. */
export const AGENT_TAB_BAR_CLASS = "flex h-10 shrink-0 items-center border-b border-secondary";

/**
 * A profile-panel tab with nothing in it yet: the tab's own icon, what will show up here, and how
 * to make it show up (`docs/design/empty-states.md`), as Raft's Agent panel does for Reminders.
 */
export function AgentTabEmpty({
  icon: Icon,
  title,
  description,
  belowBar = false,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  /** The tab draws an `AGENT_TAB_BAR_CLASS` bar above it: start that much higher, so the empty
   * state stays put when the viewer switches tabs. */
  belowBar?: boolean;
}) {
  return (
    // Upper middle of the panel, a fixed distance under the tab strip in every tab.
    <Empty
      className={cn(
        "justify-start px-6 pb-12",
        belowBar ? "pt-[calc(min(22vh,12rem)-2.5rem)]" : "pt-[min(22vh,12rem)]",
      )}
    >
      <EmptyHeader className="mb-0 max-w-80">
        <EmptyMedia className="mb-2">
          <Icon aria-hidden="true" className="size-8 text-fg-quaternary" />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
