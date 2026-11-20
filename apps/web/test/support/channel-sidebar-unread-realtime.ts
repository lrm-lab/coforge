import type { ViewerEvent } from "#src/features/conversations/conversation-realtime";
import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

export function recordingRealtime() {
  const viewerEvents: { userIds: readonly string[]; event: ViewerEvent }[] = [];
  const activities: { userIds: readonly string[]; event: ConversationActivityEvent }[] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged() {},
    async channelUpdated() {},
    async viewerChanged(input) {
      viewerEvents.push(input);
    },
    async viewerEventsChanged(input) {
      for (const event of input.events) viewerEvents.push({ userIds: input.userIds, event });
    },
    async conversationActivity(input) {
      activities.push(input);
    },
    async conversationReadChanged() {},
    async activityChanged() {},
  };
  return { realtime, viewerEvents, activities };
}
