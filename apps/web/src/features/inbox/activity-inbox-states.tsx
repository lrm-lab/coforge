import { Activity, AtSign } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

export function ActivityInboxEmpty({
  filter,
  onShowAll,
}: {
  filter: ActivityInboxFilter;
  onShowAll: () => void;
}) {
  const title =
    filter === "mentions"
      ? m.activity_inbox_empty_mentions_title()
      : filter === "unread"
        ? m.activity_inbox_empty_unread_title()
        : m.activity_inbox_empty_title();
  const description =
    filter === "mentions"
      ? m.activity_inbox_empty_mentions_description()
      : m.activity_inbox_empty_description();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {filter === "mentions" ? (
              <AtSign aria-hidden="true" />
            ) : (
              <Activity aria-hidden="true" />
            )}
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {filter !== "all" && (
          <EmptyContent>
            <Button size="sm" color="secondary" onClick={onShowAll}>
              {m.activity_inbox_show_all()}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}

export function ActivityInboxLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.activity_inbox_load_error()}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" color="secondary" onClick={onRetry}>
            {m.activity_inbox_retry()}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
