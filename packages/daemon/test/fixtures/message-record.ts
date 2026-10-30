/** A message as the Agent message API returns it, with a numbered body. */
export function messageRecord(
  sequence: number,
  sender: string,
  target: string,
  id = `message-${sequence}`,
) {
  return {
    id,
    sequence,
    senderKind: "human" as const,
    senderHandle: sender.replace(/^@/, ""),
    senderDescription: "",
    target,
    body: `body-${sequence}`,
    createdAt: "2026-09-03T00:00:00Z",
    attachments: [],
  };
}
