import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowRight } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { ChatWireframe, InboxDoneWireframe } from "#src/components/ui/empty-wireframes";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

export function ActivityInboxEmpty({ filter }: { filter: ActivityInboxFilter }) {
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const title =
    filter === "mentions"
      ? m.empty_activity_mentions_title()
      : filter === "unread"
        ? m.activity_inbox_empty_unread_title()
        : filter === "tasks"
          ? m.empty_activity_tasks_title()
          : filter === "artifacts"
            ? m.empty_activity_artifacts_title()
            : m.empty_activity_caught_up_title();
  const description =
    filter === "mentions"
      ? m.empty_activity_mentions_description()
      : filter === "unread"
        ? m.empty_activity_unread_description()
        : filter === "tasks"
          ? m.empty_activity_tasks_description()
          : filter === "artifacts"
            ? m.empty_activity_artifacts_description()
            : m.empty_activity_caught_up_description();
  return (
    <EmptyState
      size="page"
      className="h-full"
      picture={<InboxDoneWireframe />}
      title={title}
      description={description}
      primaryAction={
        filter === "tasks" ? (
          <Button
            size="sm"
            color="tertiary"
            iconTrailing={ArrowRight}
            onPress={() =>
              void navigate({
                to: "/w/$workspaceSlug/projects",
                params: { workspaceSlug },
              })
            }
          >
            {m.empty_activity_tasks_view_all()}
          </Button>
        ) : undefined
      }
    />
  );
}

export function ActivityInboxIdlePane({ emptyState }: { emptyState?: ReactNode }) {
  return (
    <div
      data-activity-idle-pane
      className="hidden min-h-0 min-w-0 flex-1 flex-col bg-primary lg:flex"
    >
      {emptyState ?? (
        <EmptyState
          size="page"
          className="h-full"
          picture={<ChatWireframe />}
          title={m.empty_activity_none_selected_title()}
          description={m.empty_activity_none_selected_description()}
        />
      )}
    </div>
  );
}

export function ActivityInboxLoadError({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <EmptyState
      size="page"
      role="alert"
      className="h-full"
      picture={<EmptyIcon icon={AlertCircle} />}
      title={m.empty_activity_load_failed_title()}
      description={m.empty_load_failed_safe()}
      primaryAction={<RetryButton size="page" isRetrying={retrying} onPress={onRetry} />}
    />
  );
}
