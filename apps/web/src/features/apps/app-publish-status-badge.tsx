import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import type { AppPublishStatus } from "./app-publish-status";

/** How the editor's status line and the app card name a status. A pending removal reads
 * "Offline requested" on a card and "Offline pending" in the editor, as Raft words them. */
export function publishStatusLabel(status: AppPublishStatus, place: "card" | "editor"): string {
  switch (status) {
    case "publish_requested":
      return m.apps_publish_status_review_pending();
    case "unpublish_requested":
      return place === "card"
        ? m.apps_publish_status_offline_requested()
        : m.apps_publish_status_offline_pending();
    case "published":
      return m.apps_publish_status_published();
    case "rejected":
      return m.apps_publish_status_rejected();
    case "private":
      return m.apps_publish_status_private();
  }
}

/** The app's Marketplace status as a badge: success when listed, warning while a request waits
 * or after a rejection, otherwise neutral. */
export function PublishStatusBadge({
  status,
  place,
}: {
  status: AppPublishStatus;
  place: "card" | "editor";
}) {
  const color = status === "published" ? "success" : status === "private" ? "gray" : "warning";
  return (
    <Badge size="sm" color={color}>
      {publishStatusLabel(status, place)}
    </Badge>
  );
}
