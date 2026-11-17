import { m } from "#src/paraglide/messages";
import type { ActivityArtifactItem } from "#src/server/inbox/activity-inbox.server";

function eventText({ event }: Pick<ActivityArtifactItem, "event">) {
  switch (event.kind) {
    case "version":
      return m.activity_artifact_version({ version: event.version ?? 0 });
    case "review":
      return event.mentioned
        ? m.activity_artifact_mentioned_in_review({ count: event.reviewComments ?? 0 })
        : m.activity_artifact_review({ count: event.reviewComments ?? 0 });
    case "comment_edited":
      return m.activity_artifact_comment_edited();
    case "comment":
      return event.mentioned ? m.activity_artifact_mentioned() : m.activity_artifact_commented();
  }
}

function eventPreview({ event }: Pick<ActivityArtifactItem, "event">) {
  if (event.preview) return event.preview;
  return event.imageCount > 0 ? m.activity_artifact_images({ count: event.imageCount }) : "";
}

export function artifactEventLine(item: Pick<ActivityArtifactItem, "event">) {
  const preview = eventPreview(item);
  const text = eventText(item);
  return preview ? m.activity_artifact_line({ event: text, preview }) : text;
}
