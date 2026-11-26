import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";
import { commentAnchorLabel } from "./comment-anchor-format";
import {
  AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT,
  type AgentAttachmentComment,
  type AgentAttachmentCommentsRequest,
  type AgentAttachmentCommentsResponse,
} from "@lrm/coforge-sdk/agent";
import { renderMessageSender, UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { parseCliFlags } from "./cli-flags";
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

export function parseAttachmentCommentsArgs(args: readonly string[]): AttachmentCommentsInvocation {
  const { values, positionals } = parseCliFlags({
    args,
    options: {
      json: { type: "boolean" },
      id: { type: "string" },
      limit: { type: "string" },
      before: { type: "string" },
    },
    maxPositionals: 1,
    onError(error) {
      if (error.kind === "missing-value") {
        if (error.flag === "--limit")
          wholeNumber(undefined, "--limit", AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT);
        if (error.flag === "--before") wholeNumber(undefined, "--before", Number.MAX_SAFE_INTEGER);
        if (error.flag === "--id")
          throw invalid("attachment id is required (pass <attachmentId> or --id)");
      }
      throw new Error(
        "Usage: coforge attachment comments [--id] <attachmentId> [--limit <n>] [--before <sequence>] [--json]",
      );
    },
  });
  const positionalId = positionals[0];
  const explicitId = values.id;
  const limit =
    values.limit === undefined
      ? undefined
      : wholeNumber(values.limit, "--limit", AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT);
  const before =
    values.before === undefined
      ? undefined
      : wholeNumber(values.before, "--before", Number.MAX_SAFE_INTEGER);
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
    ...(values.json ? { json: true } : {}),
  };
}

function commentLine(comment: AgentAttachmentComment): string {
  const sender = renderMessageSender(
    comment.senderKind,
    foldUntrustedLine(comment.senderHandle ?? comment.senderName),
  );
  const resolved = comment.resolved ? " ✅" : "";
  const anchor = comment.anchor ? ` at="${commentAnchorLabel(comment.anchor)}"` : "";
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
