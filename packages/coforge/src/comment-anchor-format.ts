import type { AgentAttachmentCommentAnchor } from "@lrm/coforge-sdk/agent";
import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";

const COMMENT_ANCHOR_LABEL_LIMIT = 60;

function clip(value: string): string {
  // `"` is the `at="…"` delimiter: fold it to a single quote rather than end the attribute early.
  const folded = foldUntrustedLine(value).replaceAll('"', "'");
  return folded.length > COMMENT_ANCHOR_LABEL_LIMIT
    ? `${folded.slice(0, COMMENT_ANCHOR_LABEL_LIMIT)}…`
    : folded;
}

/** The comment's anchor as Raft shows it, `at="…"`: the quoted text when the anchor kept one
 * (folded to a line and truncated), else the anchor's own label — a section title, a line range,
 * a timestamp, or the type itself when this CLI does not know it. */
export function commentAnchorLabel({ type, data }: AgentAttachmentCommentAnchor): string {
  if (typeof data.quote === "string" && data.quote) return clip(data.quote);
  if (type === "md-section") {
    const title = data.headingTitle ?? data.headingId;
    return typeof title === "string" && title ? `§ ${clip(title)}` : "§ section";
  }
  if (type === "lines") return range(data.start, data.end, "L") ?? type;
  if (type === "csv-rows") return range(data.start, data.end, "rows ") ?? type;
  if (type === "html-region") return "HTML region";
  if (type === "video-timestamp") {
    const time = Number(data.time);
    return Number.isFinite(time) && time >= 0 ? `@ ${videoTime(time)}` : type;
  }
  return clip(type);
}

/** The ` at="…"` a comment's line carries after its header, or nothing for a plain message. */
export function commentAnchorAt(message: {
  attachmentCommentAnchor?: AgentAttachmentCommentAnchor;
}): string {
  return message.attachmentCommentAnchor
    ? ` at="${commentAnchorLabel(message.attachmentCommentAnchor)}"`
    : "";
}

/** `start`–`end` as `L12–15` or, with a prefix, `rows 2–9`; a one-number range prints alone. */
function range(start: unknown, end: unknown, prefix: string): string | undefined {
  const from = Number(start);
  if (!Number.isFinite(from)) return undefined;
  const to = end === undefined ? from : Number(end);
  return from === to || !Number.isFinite(to) ? `${prefix}${from}` : `${prefix}${from}–${to}`;
}

/** A time in a video as players show it: `m:ss`, or `h:mm:ss` from an hour on. */
function videoTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
