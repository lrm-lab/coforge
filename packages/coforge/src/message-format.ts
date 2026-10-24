import { channelSummaryBody } from "./message-summary";
import { fenceMessageBody } from "./message-body-format";
import {
  renderMessageSender,
  UUID_LIKE_PATTERN,
  type AgentMessageRecord,
} from "@lrm/coforge-sdk/internal";

export function messageSender(message: AgentMessageRecord): string {
  return renderMessageSender(message.senderKind, message.senderHandle, message.senderDescription);
}

export function isThreadTarget(target: string): boolean {
  return target.includes(":");
}

export function shortId(id: string): string {
  return id.slice(0, 13);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatUtcTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}Z`;
}

/** `YYYY-MM-DD HH:MM:SS +08:00`: the time on this machine's clock, with its offset from UTC. */
export function formatLocalTimeWithOffset(createdAt: string): string {
  const date = new Date(createdAt);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

export function attachmentSuffix(message: AgentMessageRecord): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return "";
  const noun = attachments.length === 1 ? "attachment" : "attachments";
  const list = attachments.map(({ fileName, id }) => `${fileName} (id:${id})`).join(", ");
  return ` [${attachments.length} ${noun}: ${list} — use \`coforge attachment view --id <attachmentId> --output <path>\` to download]`;
}

export function taskSuffix(message: AgentMessageRecord): string {
  if (!message.task) return "";
  const owner = message.task.owner
    ? ` owner=@${message.task.owner.handle}${message.task.owner.deleted ? " [deleted]" : ""}`
    : "";
  return ` [task #${message.task.number} status=${message.task.status}${owner}]`;
}

export const TASK_WORKFLOW_HINT = "Tracked Tasks: coforge manual get tasks";

export function formatTaskWorkflowHint(messages: readonly AgentMessageRecord[]): string {
  return messages.some((message) => message.task) ? TASK_WORKFLOW_HINT : "";
}

export function formatMessageLine(message: AgentMessageRecord): string {
  const notice = message.nonMemberMention ? `\n${NON_MEMBER_MENTION_NOTICE}` : "";
  return `[target=${message.target} msg=${shortId(message.id)} time=${formatUtcTimestamp(message.createdAt)} type=${message.senderKind}] ${messageSender(message)}: ${fenceMessageBody(channelSummaryBody(message))}${attachmentSuffix(message)}${taskSuffix(message)}${memoryHintSuffix(message)}${notice}`;
}

export const NON_MEMBER_MENTION_NOTICE =
  "[CoForge notice: You were notified as a non-member, so you cannot reply in that channel. If no reply is needed, no action is required. Otherwise, DM the person who mentioned you or join the channel to participate.]";

const STRUCTURAL_TAG_PATTERN = /<\/?(?:result|preview|match)>|<omit \/>/g;
const REFERENCE_BOUNDARY = String.raw`[\s\[\]\(\)\{\}"'` + "`]";
const MENTION_PATTERN = new RegExp(`(^|${REFERENCE_BOUNDARY})@([A-Za-z0-9][\\w-]*)`, "g");
const CHANNEL_PATTERN = new RegExp(`(^|${REFERENCE_BOUNDARY})#([A-Za-z][\\w-]*)`, "g");
const TASK_REFERENCE_PATTERN = /\btask #(\d+)/gi;

export function neutralizeReferenceLiterals(text: string): string {
  let result = text.replace(STRUCTURAL_TAG_PATTERN, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
  result = result.replace(
    MENTION_PATTERN,
    (_match, boundary: string, name: string) => `${boundary}user:${name}`,
  );
  result = result.replace(
    CHANNEL_PATTERN,
    (_match, boundary: string, name: string) => `${boundary}channel:${name}`,
  );
  result = result.replace(TASK_REFERENCE_PATTERN, (_match, number: string) => `task:${number}`);
  return result;
}

type SendResponse = {
  messageId?: string;
};

export function formatSendSuccess(
  target: string,
  response: SendResponse,
  recentUnread?: readonly AgentMessageRecord[],
  /** Some @mention did not reach its target: the message is only queued. */
  queued = false,
): string {
  const verb = queued ? "queued" : "sent";
  const base = !response.messageId
    ? `Message ${verb} to ${target}.`
    : (() => {
        const hint = isThreadTarget(target)
          ? ""
          : ` (to reply in this message's thread, use target "${target}:${shortId(response.messageId!)}")`;
        return `Message ${verb} to ${target}. Message ID: ${response.messageId}${hint}`;
      })();
  if (!recentUnread?.length) return base;
  const lines = [
    base,
    "",
    "--- New messages you may have missed ---",
    ...recentUnread.map(formatMessageLine),
  ];
  const taskHint = formatTaskWorkflowHint(recentUnread);
  if (taskHint) lines.push(taskHint);
  return lines.join("\n");
}

export function formatSendCommitted(target: string, messageId: string): string {
  return [
    `Message commit confirmed for ${target}. Message ID: ${messageId}`,
    "The original response was lost, so delivery-side receipt details (including mention delivery warnings and recent unread context) are unavailable; no message was replayed.",
  ].join("\n");
}

type AttachmentUploadResponse = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export function formatAttachmentUploadSuccess(response: AttachmentUploadResponse): string {
  const sizeKB = (response.sizeBytes / 1024).toFixed(1);
  return (
    `File uploaded: ${response.fileName} (${sizeKB}KB)\n` +
    `Attachment ID: ${response.id}\n\n` +
    `Use this ID with coforge message send --attachment-id ${response.id} to include it in a message.`
  );
}

export function formatAttachmentDownloadSuccess(output: string): string {
  return `Downloaded to: ${output}`;
}

type HeldSendResponse = {
  decision?: "local_hold" | "syncing_hold";
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  heldMessages?: AgentMessageRecord[];
  continueAnywaySuggested?: boolean;
};

const HELD_PREVIEW_CHARS = 160;

function formatUtcHourMinute(createdAt: string): string {
  return formatUtcTimestamp(createdAt).slice(11, 16);
}

function heldPreviewLine(message: AgentMessageRecord): string {
  const collapsed = message.body.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  const shown = points.slice(0, HELD_PREVIEW_CHARS).join("");
  const hidden = points.length - Math.min(points.length, HELD_PREVIEW_CHARS);
  const head = [messageSender(message), formatUtcHourMinute(message.createdAt)]
    .filter(Boolean)
    .join(" ");
  const marker = hidden > 0 ? `…⟨${hidden} more chars⟩` : "";
  return `  │ ${head}  ${shown}${marker}`;
}

export function formatHeldSend(target: string, response: HeldSendResponse): string {
  const heldMessages = response.heldMessages ?? [];
  const newMessageCount = response.newMessageCount ?? heldMessages.length;
  const shownMessageCount = response.shownMessageCount ?? heldMessages.length;
  const omittedMessageCount = response.omittedMessageCount ?? 0;
  const messageNoun = newMessageCount === 1 ? "message" : "messages";

  const lines: string[] = [];
  if (omittedMessageCount > 0 && heldMessages.length > 0) {
    const noun = omittedMessageCount === 1 ? "message" : "messages";
    lines.push(
      `  ├ ⋯ ${omittedMessageCount} earlier ${noun} skipped in this notice. Older exist: coforge message read --target "${target}" --before ${shortId(heldMessages[0]!.id)}. ⋯`,
    );
  }
  if (heldMessages.length > 0) {
    lines.push(`  ├ Latest ${shownMessageCount} ${"─".repeat(28)}`);
    for (const message of heldMessages) lines.push(heldPreviewLine(message));
  }
  lines.push(`  └ Previews are truncated. Full text: coforge message read --target "${target}"`);

  const paths = [
    "After reviewing the current state of this conversation, choose one path.",
    "To update the draft, send revised content normally:",
    `  coforge message send --target "${target}" <<'COFORGE_MESSAGE'`,
    "  revised message",
    "  COFORGE_MESSAGE",
    // "10 minutes" mirrors the daemon's `AGENT_MESSAGE_DRAFT_TTL_MS`
    // (`packages/daemon/src/persistence/agent-message-draft-store.ts`), which the CLI cannot import.
    "To send the current draft unchanged (within 10 minutes; after that the draft is discarded and --send-draft reports SEND_DRAFT_EXPIRED):",
    `  coforge message send --send-draft --target "${target}"`,
    "  (this sends the stored copy — do not use it if you meant to change the content)",
    "You can also choose not to send anything.",
  ];
  if (response.continueAnywaySuggested)
    paths.push(
      "If repeated updates keep blocking the same draft and this is still the right reply, you may use:",
      `  coforge message send --send-draft --anyway --target "${target}"`,
    );

  return [
    `Held — ${newMessageCount} unread ${messageNoun} in ${target}. Your message has been saved as a draft.`,
    "",
    lines.join("\n"),
    "",
    paths.join("\n"),
  ].join("\n");
}

export type PendingMentionAction = {
  resolutionId: string;
  messageId: string;
  targetType: string;
  targetHandle: string;
  availableActions: readonly string[];
  expiresAt?: string;
};

const PENDING_MENTION_ACTION_ID = UUID_LIKE_PATTERN;

export function authoredMentionToken(handle: string): string {
  return handle.startsWith("@") ? handle : `@${handle}`;
}

export function mentionRecoveryVerbs(action: PendingMentionAction): string[] {
  if (!PENDING_MENTION_ACTION_ID.test(action.resolutionId)) return [];
  return [...new Set(action.availableActions)].filter(
    (verb) => verb === "notify" || verb === "add",
  );
}

function notifyRecoveryCommand(action: PendingMentionAction): string | null {
  return PENDING_MENTION_ACTION_ID.test(action.resolutionId)
    ? `coforge mention notify ${action.resolutionId}`
    : null;
}

export function senderPendingMention(action: PendingMentionAction) {
  return {
    resolutionId: action.resolutionId,
    messageId: action.messageId,
    targetHandle: authoredMentionToken(action.targetHandle),
    status: "not_queued" as const,
    reason: "not_in_conversation" as const,
    consequence: "This @mention did not notify anyone.",
    expiresAt: action.expiresAt ?? null,
    recoveryCommand: notifyRecoveryCommand(action),
  };
}

export function senderUnresolvedMention(handle: string) {
  return {
    targetHandle: authoredMentionToken(handle),
    status: "not_queued" as const,
    reason: "unknown_or_not_visible" as const,
    consequence: "This @mention did not notify anyone.",
    expiresAt: null,
    recoveryCommand: null,
  };
}

export function formatUndeliveredMentions(
  actions: readonly PendingMentionAction[],
  unresolvedHandles: readonly string[],
): string {
  const lines = [
    "Undelivered mentions — partial result",
    "Message effect: status=queued. Queue acceptance is the only message proof.",
    "Do not rerun `coforge message send`; the message is already queued and a retry could duplicate it.",
    "Each row below is bound to the literal @token from your message.",
    "For a literal name rather than a recipient, wrap the @handle in inline or fenced code.",
    "",
  ];
  for (const action of actions) {
    const row = senderPendingMention(action);
    const valid = row.recoveryCommand !== null;
    lines.push(`- ${row.targetHandle} — status=${row.status}`);
    lines.push(`  reason: ${row.reason}`);
    lines.push(`  consequence: ${row.consequence}`);
    lines.push(`  pending action: ${valid ? row.resolutionId : "[invalid pending action id]"}`);
    if (row.messageId) lines.push(`  message: ${row.messageId}`);
    lines.push(`  expires: ${row.expiresAt ?? "unknown"}`);
    if (!valid) {
      lines.push(
        "  recovery: unavailable because the pending action id is invalid; inspect `coforge mention pending` without resending the message.",
      );
      continue;
    }
    lines.push(`  recovery: ${row.recoveryCommand}`);
    lines.push(
      "  note: the handle resolved, but the target was not in this conversation at send time. This does not prove the person left the Workspace.",
    );
    lines.push("  note: notify exits nonzero unless the target queue accepts the delivery.");
  }
  for (const handle of new Set(unresolvedHandles)) {
    const row = senderUnresolvedMention(handle);
    lines.push(`- ${row.targetHandle} — status=${row.status}`);
    lines.push(`  reason: ${row.reason}`);
    lines.push(`  consequence: ${row.consequence}`);
    lines.push("  pending action: none; no visible target resolved for this token");
    lines.push("  expires: n/a");
    lines.push(
      "  recovery: if this was a literal name or prose, wrap it in inline/fenced code; otherwise verify the exact handle and send only a corrected follow-up mention; do not resend this message.",
    );
  }
  return lines.join("\n");
}

export function memoryHintSuffix(message: AgentMessageRecord): string {
  return message.memoryHint
    ? `\n[Memory Hint hint_id=${message.memoryHint.hint_id} tool=${message.memoryHint.tool}]`
    : "";
}
