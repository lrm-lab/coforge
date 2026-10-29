import { fenceMessageBody } from "./message-body-format";
import {
  attachmentSuffix,
  formatAgentDmHint,
  formatTaskWorkflowHint,
  formatUtcTimestamp,
  isThreadTarget,
  memoryHintSuffix,
  messageSender,
  taskSuffix,
} from "./message-format";
import { shortId } from "./short-id";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";

export type ReadWindowResponse = {
  messages?: AgentMessageRecord[];
  hasOlder?: boolean;
  hasNewer?: boolean;
  unreadCursorBefore?: number;
  readPositionAfter?: number;
  moreUnread?: boolean;
  foldedMessageCount?: number;
  foldedFromSequence?: number;
  foldedThroughSequence?: number;
};

const COVERAGE_THREAD = "Coverage: this thread target only.";
const COVERAGE_TOP_LEVEL =
  "Coverage: top-level messages in this target only; thread replies are excluded and must be read from their thread targets.";

const sequenceRange = (from?: number, through?: number) =>
  from === through ? `seq ${from}` : `seq ${from}-${through}`;

/** The header of an unread read: what it returned, from where the Agent's read position stood. */
function unreadHeader(messages: readonly AgentMessageRecord[], cursorBefore: number): string {
  const range = sequenceRange(messages[0]!.sequence, messages.at(-1)!.sequence);
  return `Unread window: ${messages.length} returned, ${range}, oldest to newest, starting after your read position (seq ${cursorBefore}).`;
}

const readPositionMoved = (response: ReadWindowResponse) =>
  (response.readPositionAfter ?? 0) > (response.unreadCursorBefore ?? 0);

/** One line for the messages an unread read left out because the Agent was already shown them;
 * when the read position did not move, it also says how to see them again. */
function foldedLine(target: string, response: ReadWindowResponse): string | undefined {
  const count = response.foldedMessageCount ?? 0;
  if (count === 0) return undefined;
  const range = sequenceRange(response.foldedFromSequence, response.foldedThroughSequence);
  const line =
    count === 1
      ? `1 message you were already shown (${range}) is not repeated.`
      : `${count} messages you were already shown (${range}) are not repeated.`;
  if (readPositionMoved(response)) return line;
  return `${line} To see ${count === 1 ? "it" : "them"} again: coforge message read --target "${target}" --after ${response.unreadCursorBefore ?? 0}`;
}

/** The unread read's footer: where the read position moved (only when messages were shown and it
 * did), and whether more remain. */
function unreadFooter(target: string, response: ReadWindowResponse, shown: boolean): string[] {
  const before = response.unreadCursorBefore ?? 0;
  const lines =
    shown && readPositionMoved(response)
      ? [
          `Read position: seq ${before} → ${response.readPositionAfter}. To re-read these: coforge message read --target "${target}" --after ${before}`,
        ]
      : [];
  lines.push(
    response.moreUnread
      ? `More unread remain. Next: coforge message read --target "${target}" --unread`
      : "No more unread in this target.",
  );
  return lines;
}

/** The header of a history read: how many messages, and where older and newer ones are. */
function readWindowHeader(
  target: string,
  response: ReadWindowResponse,
  messages: readonly AgentMessageRecord[],
): string {
  const older = response.hasOlder
    ? `Older exist: coforge message read --target "${target}" --before ${shortId(messages[0]!.id)}.`
    : "No older.";
  const newer = response.hasNewer
    ? `Newer exist: coforge message read --target "${target}" --after ${shortId(messages.at(-1)!.id)}.`
    : "No newer.";
  const range = sequenceRange(messages[0]!.sequence, messages.at(-1)!.sequence);
  return `Read window: ${messages.length} returned, ${range}, oldest to newest. ${older} ${newer}`;
}

export function formatReadWindow(
  target: string,
  response: ReadWindowResponse,
  options: { around?: string; unread?: boolean } = {},
): string {
  const messages = response.messages ?? [];
  const coverage = isThreadTarget(target) ? COVERAGE_THREAD : COVERAGE_TOP_LEVEL;
  const folded = options.unread ? foldedLine(target, response) : undefined;
  if (messages.length === 0) {
    if (!options.unread) return `No messages in ${target}.`;
    if (!folded) {
      const through = response.readPositionAfter ?? response.unreadCursorBefore ?? 0;
      return [
        coverage,
        "",
        response.moreUnread
          ? `No unread messages from others in ${target} up to seq ${through}.`
          : `No unread messages in ${target}. You have read through seq ${through}.`,
        ...(response.moreUnread ? unreadFooter(target, response, false) : []),
      ].join("\n");
    }
    return [
      `No new unread messages in ${target}. ${folded}`,
      ...unreadFooter(target, response, false),
    ].join("\n");
  }

  const lines = [
    options.unread
      ? unreadHeader(messages, response.unreadCursorBefore ?? 0)
      : readWindowHeader(target, response, messages),
    coverage,
  ];
  if (options.around)
    lines.push(
      `Around: ${options.around}. Your read position did not move. To read new messages and mark them read, use --unread.`,
    );
  if (folded) lines.push(folded);
  if (!options.unread && response.unreadCursorBefore !== undefined) {
    const advanced =
      response.readPositionAfter !== undefined &&
      response.readPositionAfter > response.unreadCursorBefore;
    lines.push(
      advanced
        ? `Read position: seq ${response.unreadCursorBefore} → ${response.readPositionAfter}.`
        : `Server unread cursor before this read: seq ${response.unreadCursorBefore}. Use coforge message read --target "${target}" --after ${response.unreadCursorBefore} to browse newer messages.`,
    );
  }
  const taskHint = formatTaskWorkflowHint(messages);
  if (taskHint) lines.push(taskHint);
  lines.push("");

  // An attachment takes top-level comments only, so naming a reply target there would point an
  // Agent at a send that is refused.
  const includeReplyTarget = !isThreadTarget(target) && !target.startsWith("attachment:");
  messages.forEach((message, index) => {
    const replyTarget = includeReplyTarget ? ` replyTarget=${target}:${shortId(message.id)}` : "";
    lines.push(
      `[${index + 1}/${messages.length} msg=${message.id} seq=${message.sequence}${message.replyCount ? ` replyCount=${message.replyCount}` : ""} time=${formatUtcTimestamp(message.createdAt)} type=${message.senderKind}${replyTarget}] ${messageSender(message)}: ${fenceMessageBody(message.body)}${attachmentSuffix(message)}${taskSuffix(message)}${memoryHintSuffix(message)}`,
    );
  });

  lines.push("");
  lines.push(`End of window: ${messages.length}/${messages.length} shown.`);
  const dmHint = formatAgentDmHint(messages);
  if (dmHint) lines.push(dmHint);
  if (options.unread) lines.push(...unreadFooter(target, response, true));
  return lines.join("\n");
}
