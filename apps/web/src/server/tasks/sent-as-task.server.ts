import type { TaskPriorityLevel } from "@lrm/coforge-sdk/internal";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import { sentMessageSpawnsTask } from "./sent-as-conversation-task.server";

/** The hook a person's "send as task" runs: the message is the source of a task made beside it. */
export const sentAsTaskHook =
  (priority?: TaskPriorityLevel): SentMessageHook =>
  (tx, message) =>
    sentMessageSpawnsTask(tx, message, priority);
