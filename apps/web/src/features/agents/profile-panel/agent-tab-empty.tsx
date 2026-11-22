import type { ComponentType, ReactNode, SVGProps } from "react";

import { EmptyState } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";

export const AGENT_TAB_BAR_CLASS =
  "flex h-agent-tab-bar shrink-0 items-center border-b border-secondary";

export function AgentTabEmpty({
  icon: Icon,
  picture,
  title,
  description,
  belowBar = false,
  level = 2,
}: {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  picture?: ReactNode;
  title: string;
  description: string;
  belowBar?: boolean;
  level?: 1 | 2 | 3;
}) {
  return (
    <EmptyState
      headingLevel={level}
      picture={
        picture ??
        (Icon ? (
          <span className="flex size-12 items-center justify-center rounded-xl bg-secondary text-fg-quaternary ring-1 ring-secondary ring-inset">
            <Icon aria-hidden="true" className="size-6" />
          </span>
        ) : undefined)
      }
      title={title}
      description={description}
      className={cn(
        "justify-start px-6 pb-12",
        belowBar
          ? "pt-[calc(min(22vh,12rem)-var(--spacing-agent-tab-bar))]"
          : "pt-[min(22vh,12rem)]",
      )}
    />
  );
}
