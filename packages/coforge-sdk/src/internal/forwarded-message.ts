/**
 * The original a forwarded message carries, as an Agent reads it (`AgentMessageRecord.forwarded`).
 * The message's own `body` stays the forwarder's note; this is the frozen snapshot beside it.
 */
export type ForwardedMessage = {
  /** `#name` of the channel the original was in, or `DM`. */
  from: string;
  /** True when the original was a reply in a thread. */
  thread?: true;
  /** The original's sender, `@handle`. */
  sender: string;
  /** When the original was sent, ISO 8601. */
  sentAt: string;
  /** The original's text, mentions and references already plain text. */
  body: string;
  /** The ids of the forwarded message's attachments, which are copies of the original's. */
  attachments: string[];
};

const pad = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DD HH:MM:SSZ`, how an Agent reads a time anywhere in CoForge output. */
export function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}

/** Every separator a terminal or a Markdown reader breaks a line on; CRLF is one. */
export const MESSAGE_LINE_SEPARATOR = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;

/**
 * A forwarded message as text: `[forwarded from #x by @y at <time>]`, then the snapshot as a
 * quote block, every line behind `> ` so quoted text cannot pass for output of its own. The
 * attachment ids are listed only when the reader has no other list of them (`withAttachmentIds`;
 * a daemon delivery carries none, a message read does).
 */
export function renderForwardedMessage(
  forwarded: ForwardedMessage,
  options: { withAttachmentIds?: boolean } = {},
): string {
  const where = forwarded.thread ? `${forwarded.from} (thread)` : forwarded.from;
  const lines = [
    `[forwarded from ${where} by ${forwarded.sender} at ${formatUtcTimestamp(forwarded.sentAt)}]`,
  ];
  if (forwarded.body)
    lines.push(...forwarded.body.split(MESSAGE_LINE_SEPARATOR).map((line) => `> ${line}`));
  if (options.withAttachmentIds && forwarded.attachments.length)
    lines.push(`[forwarded attachments: ${forwarded.attachments.join(", ")}]`);
  return lines.join("\n");
}
