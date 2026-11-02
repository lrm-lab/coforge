import type { ComponentType, SVGProps } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";

/**
 * A profile-panel tab with nothing in it yet: the tab's own icon, what will show up here, and how
 * to make it show up (`docs/design/empty-states.md`), as Raft's Agent panel does for Reminders.
 */
export function AgentTabEmpty({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
}) {
  return (
    <Empty className="min-h-[min(32rem,60vh)] px-6 py-12">
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
