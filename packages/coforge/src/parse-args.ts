import { parseVersionArgs } from "#src/version-commands";
import { parseMemoryArgs, type MemoryInvocation } from "./memory-commands";
import { parseProcArgs, type ProcInvocation } from "./proc-commands";
import { invalidArgument, unknownCommandError } from "#src/command-help/index";
import { parseChannelManagementArgs, type ChannelManagementInvocation } from "#src/channel-args";
import {
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_SOURCE,
  UUID_LIKE_PATTERN,
  isValidReactionEmoji,
  parseMentionSelector,
  type MentionSelectorInput as MentionSelector,
} from "@lrm/coforge-sdk/internal";
import { parseWhoamiArgs, type WhoamiInvocation } from "#src/whoami";
import { parseProfileUpdateArgs, type ProfileUpdateInvocation } from "#src/profile-update";
import { parseContextArgs, type ContextInvocation } from "#src/context-commands";
import { parseAttachmentViewArgs } from "#src/attachment-view-args";
import {
  parseAttachmentCommentsArgs,
  type AttachmentCommentsInvocation,
} from "#src/attachment-comments";
import { parseUserInfoArgs, type UserInfoInvocation } from "#src/user-info";
import { parseAppConfigArgs, type AppConfigInvocation } from "#src/app-config";
import { parseArtifactArgs, type ArtifactInvocation } from "#src/artifact-commands";
import { refuseTaskRef } from "#src/send-undelivered";
import { parseMessageContinueArgs } from "#src/message-continue";
import { parseMessageSendArgs } from "#src/send-args";
import { type WeeklyReportCollectInvocation } from "#src/weekly-report-collect";
import { parseWorkspaceInfoArgs, type WorkspaceInfoInvocation } from "#src/workspace-info";
import { parseMessageSearchArgs } from "#src/message-search-args";
import { parseMessageReadArgs } from "#src/message-read-args";
import { parseLabelArgs, type LabelInvocation } from "#src/label-commands";
import { CliError, NO_MESSAGE_SENT_NEXT_ACTION, withOutputMode } from "#src/cli-error";
import { parseMentionArgs } from "#src/mention-args";
import { parseTaskArgs, type TaskInvocation } from "#src/task-args";
import { reviewerIsolationFromEnvironment } from "#src/reviewer-isolation";
import type { TaskConversationInvocation } from "#src/task-conversation-args";
import {
  parseAttentionArgs,
  type ChannelInvocation,
  type InboxInvocation,
  type ThreadInvocation,
} from "#src/attention-args";
import { parseReminderArgs } from "#src/reminder-commands";
import type { ReminderInvocation } from "#src/reminder-commands";
import type { MessageCommand } from "../index";
import type { MessageInvocation } from "../index";
import type { AttachmentInvocation } from "../index";
import type { AttachmentUploadInvocation } from "../index";
import type { WeeklyReportInvocation } from "../index";
import type { WeeklyReportKeyPointsInvocation } from "../index";
import type { WeeklyReportMemoryInvocation } from "../index";
import type { ActionPrepareInvocation } from "../index";
import type { ManualInvocation } from "../index";
import type { VersionInvocation } from "../index";
import type { ProfileShowInvocation } from "../index";
import type { MentionInvocation } from "../index";
import { parseManualArgs } from "./query-args";
import { parseProfileShowArgs } from "./query-args";
import { parseActionPrepareArgs } from "./query-args";
import { parseWeeklyReportCollectArgs } from "./weekly-report-args";
import { parseWeeklyReportKeyPointsArgs } from "./weekly-report-args";
import { parseWeeklyReportMemoryArgs } from "./weekly-report-args";
import { parseWeeklyReportArgs } from "./weekly-report-args";

const MESSAGE_ANCHOR_PATTERN = new RegExp(
  `^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`,
  "i",
);

const UUID_PATTERN = UUID_LIKE_PATTERN;

export function parseArgs(
  args: readonly string[],
):
  | MessageInvocation
  | AttachmentInvocation
  | AttachmentUploadInvocation
  | InboxInvocation
  | ChannelInvocation
  | ChannelManagementInvocation
  | ReminderInvocation
  | ThreadInvocation
  | TaskInvocation
  | TaskConversationInvocation
  | WorkspaceInfoInvocation
  | WeeklyReportInvocation
  | WeeklyReportCollectInvocation
  | WeeklyReportKeyPointsInvocation
  | WeeklyReportMemoryInvocation
  | ActionPrepareInvocation
  | ManualInvocation
  | WhoamiInvocation
  | VersionInvocation
  | ContextInvocation
  | MemoryInvocation
  | ProcInvocation
  | UserInfoInvocation
  | AttachmentCommentsInvocation
  | ProfileShowInvocation
  | ProfileUpdateInvocation
  | AppConfigInvocation
  | ArtifactInvocation
  | LabelInvocation
  | MentionInvocation {
  if (args[0] === "whoami") return parseWhoamiArgs(args.slice(1));
  if (args[0] === "version") return parseVersionArgs(args.slice(1));
  if (args[0] === "memory") return parseMemoryArgs(args.slice(1));
  if (args[0] === "proc") return parseProcArgs(args.slice(1));
  if (args[0] === "context" && (args[1] === "search" || args[1] === "read"))
    return parseContextArgs(args.slice(1));
  if (args[0] === "manual" && (args[1] === "get" || args[1] === "search"))
    return parseManualArgs(args.slice(1));
  if (args[0] === "user" && args[1] === "info") return parseUserInfoArgs(args.slice(2));
  if (args[0] === "profile" && args[1] === "show") return parseProfileShowArgs(args.slice(2));
  if (args[0] === "profile" && args[1] === "update") return parseProfileUpdateArgs(args.slice(2));
  if (args[0] === "workspace" && args[1] === "info") return parseWorkspaceInfoArgs(args.slice(2));
  if (args[0] === "app" && args[1] === "config") return parseAppConfigArgs(args.slice(2));
  if (args[0] === "mention") return parseMentionArgs(args.slice(1));
  if (args[0] === "reminder") return parseReminderArgs(args.slice(1));
  if (args[0] === "artifact") return parseArtifactArgs(args.slice(1));
  if (args[0] === "task") return parseTaskArgs(args.slice(1));
  if (args[0] === "label") return parseLabelArgs(args.slice(1));
  if (args[0] === "weekly-report-collect") return parseWeeklyReportCollectArgs(args.slice(1));
  if (args[0] === "weekly-report-key-points") return parseWeeklyReportKeyPointsArgs(args.slice(1));
  if (args[0] === "weekly-report-memory") return parseWeeklyReportMemoryArgs(args.slice(1));
  if (args[0] === "weekly-report") return parseWeeklyReportArgs(args.slice(1));
  if (args[0] === "action" && args[1] === "prepare") return parseActionPrepareArgs(args.slice(2));
  const attention = parseAttentionArgs(args);
  if (attention) return attention;
  if (args[0] === "channel" && args[1] !== undefined && args[1] !== "mute" && args[1] !== "unmute")
    return parseChannelManagementArgs(args.slice(1));
  if (args[0] === "attachment" && args[1] === "view") return parseAttachmentViewArgs(args);
  if (args[0] === "attachment" && args[1] === "comments")
    return parseAttachmentCommentsArgs(args.slice(2));
  if (args[0] === "attachment" && args[1] === "upload") {
    let path: string | undefined;
    let target: string | undefined;
    // Legacy alias for --target; giving both is a usage error.
    let channelAlias: string | undefined;
    let mimeType: string | undefined;
    let json = false;
    for (let index = 2; index < args.length; index++) {
      if (args[index] === "--path" && args[index + 1]) path = args[++index];
      else if (args[index] === "--target" && args[index + 1]) target = args[++index];
      else if (args[index] === "--channel" && args[index + 1]) channelAlias = args[++index];
      else if (args[index] === "--mime-type" && args[index + 1]) mimeType = args[++index];
      else if (args[index] === "--json") json = true;
      else throw new Error("Usage:");
    }
    if (target !== undefined && channelAlias !== undefined) throw new Error("Usage:");
    return {
      command: "attachment.upload",
      path,
      target: target ?? channelAlias,
      mimeType,
      ...(json ? { json: true as const } : {}),
    };
  }
  if (args[0] === "message" && isMessageCommand(args[1])) {
    if (args[1] === "check") {
      if (args.length === 2) return { command: "check" };
      if (args[2] === "--target") {
        const target = args[3];
        if (!target) throw invalidArgument("message check", "--target needs a value.");
        if (args.length !== 4)
          throw invalidArgument("message check", `Unknown argument "${args[4] ?? ""}".`);
        return { command: "check", target };
      }
      throw invalidArgument("message check", `Unknown argument "${args[2] ?? ""}".`);
    }
    if (args[1] === "resolve") {
      const messageId = args[2];
      if (messageId && args.length === 3 && MESSAGE_ANCHOR_PATTERN.test(messageId))
        return { command: "resolve", messageId: messageId.toLowerCase() };
      throw new Error("Usage:");
    }
    if (args[1] === "react") {
      let messageId: string | undefined;
      let emoji: string | undefined;
      let remove = false;
      for (let index = 2; index < args.length; index++) {
        if (args[index] === "--message-id" && args[index + 1]) messageId = args[++index];
        else if (args[index] === "--emoji" && args[index + 1]) emoji = args[++index];
        else if (args[index] === "--remove") remove = true;
        else throw new Error("Usage:");
      }
      if (
        !messageId ||
        !emoji ||
        !MESSAGE_ANCHOR_PATTERN.test(messageId) ||
        !isValidReactionEmoji(emoji)
      )
        throw new Error("Usage:");
      return {
        command: "react",
        messageId: messageId.toLowerCase(),
        emoji,
        ...(remove ? { remove: true as const } : {}),
      };
    }
    if (args[1] === "continue") return { command: "continue", ...parseMessageContinueArgs(args) };
    if (args[1] === "search") return { command: "search", ...parseMessageSearchArgs(args) };
    if (args[1] === "read") {
      const read = parseMessageReadArgs(args);
      if (read) return { command: "read", ...read };
    } else if (args[1] === "send") {
      const flags = parseMessageSendArgs(args, reviewerIsolationFromEnvironment());
      const {
        target,
        sendDraft,
        expectedDraftKey,
        continueAnyway,
        json,
        reviewerIsolation,
        rawAttachmentIds,
        rawMentions,
        targetConfirmed,
      } = flags;
      const outputMode = json ? "json" : "text";
      if (!target?.trim())
        throw withOutputMode(
          invalidArgument(
            "message send",
            "--target is required, for example '#general' or '@ada'.",
          ),
          outputMode,
        );
      refuseTaskRef("send", target, [], outputMode);
      // Repeatable; duplicates collapse; the server caps the count.
      const attachmentIds = rawAttachmentIds.length ? [...new Set(rawAttachmentIds)] : undefined;
      if (attachmentIds?.some((id) => !UUID_PATTERN.test(id)))
        throw withOutputMode(
          new CliError({
            code: "INVALID_ARG",
            message: "--attachment-id must be a full attachment UUID.",
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
      if (attachmentIds && sendDraft)
        throw withOutputMode(
          new CliError({
            code: "SEND_DRAFT_ATTACHMENTS_UNSUPPORTED",
            message:
              "--attachment-id cannot be used with --send-draft. Use a normal send to replace the draft.",
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
      if (continueAnyway && !sendDraft)
        throw withOutputMode(
          new CliError({
            code: "SEND_DRAFT_ANYWAY_REQUIRES_SEND_DRAFT",
            message: "--anyway can only be used together with --send-draft.",
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
      if (expectedDraftKey !== undefined && !sendDraft)
        throw withOutputMode(
          new CliError({
            code: "EXPECTED_DRAFT_KEY_REQUIRES_SEND_DRAFT",
            message: "--expected-draft-key can only be used together with --send-draft.",
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
      const mentions = rawMentions.length
        ? parseMentionSelectors(rawMentions, outputMode)
        : undefined;
      if (target && (!continueAnyway || sendDraft))
        return {
          command: "send",
          target,
          ...(sendDraft ? { sendDraft: true } : {}),
          ...(expectedDraftKey !== undefined ? { expectedDraftKey } : {}),
          ...(continueAnyway ? { continueAnyway: true } : {}),
          ...(reviewerIsolation ? { freshnessContextMode: "withheld" as const } : {}),
          ...(json ? { json: true as const } : {}),
          ...(attachmentIds ? { attachmentIds } : {}),
          ...(mentions ? { mentions } : {}),
          ...(targetConfirmed ? { targetConfirmed: true } : {}),
        };
    }
  }
  throw unknownCommandError(args);
}

export function parseMentionSelectors(
  raw: readonly string[],
  outputMode: "text" | "json",
): MentionSelector[] {
  const byHandle = new Map<string, MentionSelector>();
  const result: MentionSelector[] = [];
  for (const value of raw) {
    const parsed = parseMentionSelector(value);
    if (!parsed)
      throw withOutputMode(
        new CliError({
          code: "INVALID_MENTION_SELECTOR",
          message: "--mention must be human:<actor-uuid>:<handle> or agent:<actor-uuid>:<handle>.",
          retryable: false,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        }),
        outputMode,
      );
    const existing = byHandle.get(parsed.name);
    if (existing && (existing.type !== parsed.type || existing.id !== parsed.id))
      throw withOutputMode(
        new CliError({
          code: "MENTION_BINDING_CONFLICT",
          message: `@${parsed.name} cannot be bound to more than one actor in the same message.`,
          retryable: false,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        }),
        outputMode,
      );
    if (!existing) {
      byHandle.set(parsed.name, parsed);
      result.push(parsed);
    }
  }
  return result;
}

export function isMessageCommand(value: string | undefined): value is MessageCommand {
  return (
    value === "check" ||
    value === "read" ||
    value === "search" ||
    value === "send" ||
    value === "continue" ||
    value === "resolve" ||
    value === "react"
  );
}
