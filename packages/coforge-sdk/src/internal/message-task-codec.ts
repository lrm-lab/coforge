import type { MessageTaskMetadata } from "./agent-message-record";
import { isTaskReadStatus } from "./task-status";

export function decodeMessageTask(value: {
  number: number;
  status: string;
  owner?: { displayName: string; handle: string; deleted?: boolean };
}): MessageTaskMetadata {
  if (!isTaskReadStatus(value.status)) throw new Error("invalid message Task status");
  return {
    number: value.number,
    status: value.status,
    ...(value.owner
      ? {
          owner: {
            displayName: value.owner.displayName,
            handle: value.owner.handle,
            ...(value.owner.deleted ? { deleted: true } : {}),
          },
        }
      : {}),
  };
}
