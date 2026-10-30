import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { shortId } from "./short-id";

/** Channel check/resolve lines longer than this are cut; the agent can `read --around` for the rest. */
const CHANNEL_SUMMARY_CHARS = 200;

/** A parent channel (`#name`), not a thread (`#name:rootId`) and not a DM. */
function isPlainChannelTarget(target: string): boolean {
  return target.startsWith("#") && !target.includes(":");
}

/** Truncate a plain-channel body so check does not dump the full post into the transcript. */
export function channelSummaryBody(message: AgentMessageRecord): string {
  if (!isPlainChannelTarget(message.target) || message.mentionsAgent || message.nonMemberMention)
    return message.body;
  const points = Array.from(message.body);
  if (points.length <= CHANNEL_SUMMARY_CHARS) return message.body;
  const shown = points.slice(0, CHANNEL_SUMMARY_CHARS).join("");
  const hidden = points.length - CHANNEL_SUMMARY_CHARS;
  return `${shown}…(+${hidden} chars, read: coforge message read --target "${message.target}" --around ${shortId(message.id)})`;
}
