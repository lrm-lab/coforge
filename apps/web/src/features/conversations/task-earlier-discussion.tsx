import { ArrowLeft, ChevronRight } from "@untitledui/icons";
import type { ReactNode } from "react";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

export function TaskEarlierDiscussion({
  replyCount,
  open,
  onOpenChange,
  children,
}: {
  replyCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Button
        color="tertiary"
        size="sm"
        onPress={() => onOpenChange(!open)}
        iconLeading={open ? ArrowLeft : undefined}
        iconTrailing={open ? undefined : ChevronRight}
        className="w-full shrink-0 justify-start rounded-none border-b border-secondary px-4"
      >
        {open
          ? m.tasks_earlier_discussion_back()
          : m.tasks_earlier_discussion({ count: replyCount })}
      </Button>
      {children}
    </div>
  );
}
