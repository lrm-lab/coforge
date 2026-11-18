import { ArrowLeft, ChevronRight } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

export function TaskEarlierDiscussion({
  replyCount,
  open,
  onOpenChange,
}: {
  replyCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Button
      color="link-gray"
      size="sm"
      onPress={() => onOpenChange(!open)}
      iconLeading={open ? ArrowLeft : undefined}
      iconTrailing={open ? undefined : ChevronRight}
      className="self-start"
    >
      {open ? m.tasks_earlier_discussion_back() : m.tasks_earlier_discussion({ count: replyCount })}
    </Button>
  );
}
