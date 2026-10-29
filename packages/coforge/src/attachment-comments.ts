import {
  AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT,
  type AgentAttachmentComment,
  type AgentAttachmentCommentAnchor,
  type AgentAttachmentCommentsRequest,
  type AgentAttachmentCommentsResponse,
} from "@lrm/coforge-sdk/agent";
import { renderMessageSender, UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { fenceMessageBody } from "#src/message-body-format";
import { formatUtcTimestamp } from "#src/message-format";
import { shortId } from "#src/short-id";

export type AttachmentCommentsInvocation = {
  command: "attachment-comments";
  attachmentId: string;
  limit?: number;
  before?: number;
  json?: boolean;
};

const invalid = (message: string) =>
  new CliError({ code: "INVALID_ARG", message, retryable: false });

function wholeNumber(raw: string | undefined, flag: string, maximum: number): number {
  const value = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw invalid(`${flag} must be an integer from 1 to ${maximum}`);
  return value;
}

/**
 * `attachment comments [<attachmentId> | --id <attachmentId>] [--limit <n>] [--before <seq>]
 * [--json]`. The id is the whole UUID the server looks the attachment up by, so every id this
 * command prints can be passed back to it.
 */
export function parseAttachmentCommentsArgs(args: readonly string[]): AttachmentCommentsInvocation {
  let positionalId: string | undefined;
  let explicitId: string | undefined;
  let limit: number | undefined;
  let before: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--id") explicitId = args[++index];
    else if (arg === "--limit")
      limit = wholeNumber(args[++index], arg, AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT);
    else if (arg === "--before") before = wholeNumber(args[++index], arg, Number.MAX_SAFE_INTEGER);
    else if (!arg.startsWith("--") && positionalId === undefined) positionalId = arg;
    else
      throw new Error(
        "Usage: coforge attachment comments [--id] <attachmentId> [--limit <n>] [--before <sequence>] [--json]",
      );
  }
  if (positionalId && explicitId)
    throw invalid("pass the attachment id either positionally or with --id, not both");
  const attachmentId = positionalId || explicitId;
  if (!attachmentId) throw invalid("attachment id is required (pass <attachmentId> or --id)");
  if (!UUID_LIKE_PATTERN.test(attachmentId)) throw invalid("the attachment id must be a full UUID");
  return {
    command: "attachment-comments",
    attachmentId,
    ...(limit === undefined ? {} : { limit }),
    ...(before === undefined ? {} : { before }),
    ...(json ? { json: true } : {}),
  };
}

const range = (start: unknown, end: unknown, prefix: string) => {
  const from = Number(start);
  if (!Number.isFinite(from)) return undefined;
  const to = end === undefined ? from : Number(end);
  return from === to || !Number.isFinite(to) ? `${prefix}${from}` : `${prefix}${from}–${to}`;
};

const HTML_QUOTE_LIMIT = 60;

/** Where a comment points, in a few characters; a type this CLI does not know prints as itself. */
function anchorSummary({ type, data }: AgentAttachmentCommentAnchor): string {
  if (type === "md-section") {
    const title = data.headingTitle ?? data.headingId;
    return typeof title === "string" && title ? `§ ${title}` : "§ section";
  }
  if (type === "lines") return range(data.start, data.end, "L") ?? type;
  if (type === "csv-rows") return range(data.start, data.end, "rows ") ?? type;
  if (type === "html-region") {
    const quote = typeof data.quote === "string" ? data.quote.replace(/\s+/g, " ").trim() : "";
    if (!quote) return "HTML region";
    return quote.length > HTML_QUOTE_LIMIT ? `${quote.slice(0, HTML_QUOTE_LIMIT)}…` : quote;
  }
  return type;
}

function commentLine(comment: AgentAttachmentComment): string {
  const sender = renderMessageSender(
    comment.senderKind,
    comment.senderHandle ?? comment.senderName,
  );
  const resolved = comment.resolved ? " ✅" : "";
  const anchor = comment.anchor ? ` [anchor: ${anchorSummary(comment.anchor)}]` : "";
  return `[msg=${shortId(comment.id)} time=${formatUtcTimestamp(comment.createdAt)} type=${comment.senderKind}]${resolved}${anchor} ${sender}: ${fenceMessageBody(comment.body)}`;
}

export function formatAttachmentComments(response: AgentAttachmentCommentsResponse): string {
  const { attachmentId, comments } = response;
  const lines = [
    comments.length === 0
      ? `No comments on attachment ${attachmentId}.`
      : `## Comments on attachment ${attachmentId} (${comments.length})`,
    ...comments.map(commentLine),
  ];
  if (response.hasOlder && comments.length > 0)
    lines.push(
      `More: coforge attachment comments ${attachmentId} --before ${comments[0]!.sequence}`,
    );
  lines.push(`Read: coforge message read --target 'attachment:${attachmentId}'`);
  // Attachment comments are a flat list: a reply target or a reaction on one has no place the
  // Web shows, so the CLI never suggests one.
  if (response.viewer.canComment)
    lines.push(`Comment: coforge message send --target 'attachment:${attachmentId}'`);
  if (!response.viewer.canComment)
    lines.push(
      `You cannot comment on this attachment (${response.viewer.reason ?? "unavailable"}).`,
    );
  return lines.join("\n");
}

/** `attachment comments`: the server's answer as JSON, or formatted. */
export async function runAttachmentComments(
  comments: (request: AgentAttachmentCommentsRequest) => Promise<AgentAttachmentCommentsResponse>,
  { attachmentId, limit, before, json }: AttachmentCommentsInvocation,
): Promise<AgentAttachmentCommentsResponse | string> {
  const response = await comments({ attachmentId, limit, before });
  return json ? response : formatAttachmentComments(response);
}
