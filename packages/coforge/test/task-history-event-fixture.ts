import type { TaskHistoryEvent } from "@lrm/coforge-sdk/internal";

export const historyEvent = (
  seq: number,
  createdAt: string,
  rest: Partial<TaskHistoryEvent> & Pick<TaskHistoryEvent, "eventType" | "payload">,
) =>
  ({
    id: `e${seq}`,
    seq,
    actorType: "user",
    actorName: "bob",
    createdAt,
    ...rest,
  }) as TaskHistoryEvent;
