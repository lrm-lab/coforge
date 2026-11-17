import type { MessageTaskMetadata } from "./agent-message-record";

export function decodeMessageTask(value: {
  number: number;
  status: string;
  owner?: { displayName: string; handle: string; deleted?: boolean };
}): MessageTaskMetadata {
  let status: MessageTaskMetadata["status"];
  switch (value.status) {
    case "todo":
    case "in_progress":
    case "in_review":
    case "done":
    case "closed":
      status = value.status;
      break;
    default:
      throw new Error("invalid message Task status");
  }
  return {
    number: value.number,
    status,
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
