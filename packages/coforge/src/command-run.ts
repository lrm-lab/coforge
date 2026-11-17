import { runVersion } from "#src/version-commands";
import { runMemoryCommand } from "./memory-commands";
import { cliUsage } from "#src/usage";
import { commandHelp } from "#src/command-help/index";
import { runMessageResolve } from "#src/message-resolve";
import { formatReaction } from "#src/message-format";
import { weeklyReportWorkflowSchema } from "@lrm/coforge-sdk/internal";
import {
  mentionsInContent,
  type AgentMessageRecord,
  type TaskCommand,
  validateWeeklyReportMemoryCommand,
} from "@lrm/coforge-sdk/internal";
import {
  createAgentApiClient,
  createMessageTransportAgentApiTransport,
} from "@lrm/coforge-sdk/agent";
import { formatManualGet, formatManualSearchResults } from "#src/manual-format";
import { formatProfile } from "#src/user-format";
import { runWhoami } from "#src/whoami";
import type { MessageTransport } from "#src/message-transport";
import { runContextCommand } from "#src/context-commands";
import { runAttachmentComments } from "#src/attachment-comments";
import { runUserInfo } from "#src/user-info";
import { runAppConfig } from "#src/app-config";
import { runArtifact } from "#src/artifact-commands";
import {
  formatMentionActionResults,
  formatMentionDeliveries,
  incompleteMentionActions,
  mentionDeliveryFailure,
} from "#src/mention-format";
import { runActionPrepare } from "#src/action-prepare-run";
import { formatReadWindow } from "#src/message-read-format";
import {
  formatAttachmentDownloadSuccess,
  formatAttachmentUploadSuccess,
  formatSendSuccess,
  formatSendCommitted,
  type PendingMentionAction,
} from "#src/message-format";
import { undeliveredMentionError } from "#src/send-undelivered";
import {
  heldSendCliError,
  isCommittedSend,
  isHeldSend,
  type HeldSendResult,
} from "#src/send-held-result";
import { runMessageContinue } from "#src/message-continue";
import {
  readPipedSendContent,
  refuseForeignStdinFile,
  sendDraftStdinHasContent,
} from "#src/send-stdin";
import { formatSearchResults } from "#src/search-format";
import { formatWorkspaceInfo } from "#src/workspace-info-format";
import { runWeeklyReportCollect } from "#src/weekly-report-collect";
import { formatMessageCheck } from "#src/message-check-format";
import { runChannelCommand } from "#src/channel-commands";
import { runLabelCommand } from "#src/label-commands";
import {
  CliError,
  NO_MESSAGE_SENT_NEXT_ACTION,
  unknownDeliveryNextAction,
  withOutputMode,
} from "#src/cli-error";
import { inferAttachmentMimeType, validateAttachmentUploadArgs } from "#src/attachment-upload";
import { runMentionPending } from "#src/mention-pending";
import { runInboxCheck } from "#src/inbox-check";
import { runAttention } from "#src/attention-format";
import { runTaskConversation } from "#src/task-conversation-run";
import { isAttentionInvocation } from "#src/attention-args";
import { formatTaskResult } from "#src/task-format";
import { heldTaskCliError } from "#src/task-held-result";
import { runReminder } from "#src/reminder-commands";
import { parseArgs } from "./parse-args";

export async function run(args: readonly string[], transport: MessageTransport): Promise<unknown> {
  if (args.length === 0) return cliUsage();
  if (args.includes("--help")) {
    const help = commandHelp(args.filter((arg) => arg !== "--help"));
    if (help) return help;
  }
  const invocation = parseArgs(args);
  if (invocation.command === "whoami") {
    return runWhoami(
      transport.profileShow && (() => transport.profileShow!()),
      invocation.json === true,
    );
  }
  if (invocation.command === "version") return runVersion(invocation, transport);
  if (invocation.command === "memory") return runMemoryCommand(invocation, transport);
  if (invocation.command === "context-search" || invocation.command === "context-read")
    return runContextCommand(invocation, transport);
  if (invocation.command === "manual-get") {
    if (!transport.manualGet) throw new Error("Manual transport is unavailable");
    const result = await transport.manualGet(
      invocation.topic,
      invocation.intent,
      invocation.reason,
    );
    return formatManualGet(result.content);
  }
  if (invocation.command === "manual-search") {
    if (!transport.manualSearch) throw new Error("Manual transport is unavailable");
    const result = await transport.manualSearch(
      invocation.query,
      invocation.intent,
      invocation.reason,
    );
    return formatManualSearchResults(result.results);
  }
  if (invocation.command === "user-info") {
    if (!transport.userInfo) throw new Error("User info transport is unavailable");
    return runUserInfo(transport.userInfo.bind(transport), invocation);
  }
  if (invocation.command === "profile-show") {
    if (!transport.profileShow) throw new Error("Profile transport is unavailable");
    const result = await transport.profileShow(invocation.target);
    return invocation.json ? result : formatProfile(result);
  }
  if (invocation.command === "profile-update") {
    if (!transport.profileUpdate) throw new Error("Profile transport is unavailable");
    const result = await transport.profileUpdate({
      displayName: invocation.displayName,
      description: invocation.description,
    });
    return invocation.json ? result : formatProfile(result);
  }
  if (invocation.command === "app-config") return runAppConfig(invocation, transport);
  if (invocation.command === "artifact") return runArtifact(invocation, transport);
  if (invocation.command === "mention-pending")
    return runMentionPending(transport.mentionPending?.bind(transport), invocation);
  if (invocation.command === "mention-delivery") {
    if (!transport.mentionDelivery) throw new Error("Mention transport is unavailable");
    const outputMode = invocation.json ? "json" : "text";
    const result = await transport.mentionDelivery(invocation.messageId).catch((error: unknown) => {
      throw error instanceof CliError
        ? mentionDeliveryFailure(error, invocation.messageId, outputMode)
        : error;
    });
    return invocation.json
      ? { ok: true, messageId: result.messageId, deliveries: result.deliveries }
      : formatMentionDeliveries(result.messageId, result.deliveries);
  }
  if (invocation.command === "mention-action") {
    if (!transport.mentionExecute) throw new Error("Mention transport is unavailable");
    const outputMode = invocation.json ? "json" : "text";
    const { action, resolutionIds } = invocation;
    const result = await transport
      .mentionExecute({ action, resolutionIds })
      .catch((error: unknown) => {
        throw error instanceof CliError ? withOutputMode(error, outputMode) : error;
      });
    const incomplete = incompleteMentionActions(action, resolutionIds, result.results);
    if (incomplete.length)
      throw new CliError({
        code: "MENTION_ACTION_FAILED",
        message: `Mention ${action} did not complete for every requested target: ${incomplete.join(", ")}`,
        retryable: false,
        details: { action: result.action, results: result.results },
        outputMode,
      });
    return invocation.json
      ? { ok: true, action: result.action, results: result.results }
      : formatMentionActionResults(result.action, result.results);
  }
  if (invocation.command === "workspace.info") {
    const client = createAgentApiClient(createMessageTransportAgentApiTransport(transport));
    return formatWorkspaceInfo(await client.workspace.info(), invocation);
  }
  if (invocation.command === "reminder") return runReminder(invocation, transport);
  if (invocation.command === "task") {
    if (!transport.task) throw new Error("Task transport is unavailable");
    const outputJson = invocation.json === true;
    let command = { ...invocation.task, idempotencyKey: crypto.randomUUID() } as TaskCommand;
    if (
      (command.operation === "update" || command.operation === "unclaim") &&
      command.expectedRevision === undefined
    ) {
      const listed = await transport.task({
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        target: command.target,
      });
      const current = listed.tasks.find((task) => task.number === command.number);
      if (!current)
        throw new Error(`Task #${command.number} was not found; read the Task list again`);
      command = { ...command, expectedRevision: current.revision };
    }
    try {
      const result = await transport.task(command);
      if (result.state === "held") throw heldTaskCliError(command, result, outputJson);
      return outputJson ? result : formatTaskResult(command, result);
    } catch (error) {
      // Deleting is irreversible and a refusal is an authority fact, not a race: name who may.
      if (
        error instanceof CliError &&
        command.operation === "delete" &&
        error.proxy?.upstreamStatus === 403
      )
        throw new CliError({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          correlationId: error.correlationId,
          proxy: error.proxy,
          suggestedNextAction:
            "Only the task's creator or a Workspace owner or admin can delete a task; ask one of them, or close it instead.",
        });
      // A typed failure is already redacted where it was raised; anything else may carry detail.
      if (command.freshnessContextMode === "withheld" && !(error instanceof CliError))
        throw new Error("Reviewer-isolation Task request failed; upstream detail was withheld");
      throw error;
    }
  }
  if (invocation.command === "weekly-report") {
    if (!transport.weeklyReport) throw new Error("Weekly report transport is unavailable");
    if ("inputPath" in invocation) {
      const action = weeklyReportWorkflowSchema.parse(await Bun.file(invocation.inputPath).json());
      return transport.weeklyReport({ operation: "workflow", action });
    }
    return transport.weeklyReport(invocation.weeklyReport);
  }
  if (invocation.command === "weekly-report-collect")
    return runWeeklyReportCollect(invocation, transport);
  if (invocation.command === "weekly-report-key-points") {
    if (!transport.weeklyReportKeyPoints)
      throw new Error("Weekly report key-points transport is unavailable");
    let keyPoints = invocation.keyPoints;
    if (invocation.markdownPath) {
      const markdown = await Bun.file(invocation.markdownPath).text();
      keyPoints = { ...keyPoints, markdown };
    }
    const result = await transport.weeklyReportKeyPoints(keyPoints);
    return `Key points ${result.status} (report ${result.reportId}).`;
  }
  if (invocation.command === "weekly-report-memory") {
    if (!transport.weeklyReportMemory)
      throw new Error("Weekly report memory transport is unavailable");
    const file = (await Bun.file(invocation.filePath).json()) as unknown;
    if (!file || typeof file !== "object" || Array.isArray(file))
      throw new Error("invalid weekly-report-memory file");
    const memory = validateWeeklyReportMemoryCommand({
      ...(file as Record<string, unknown>),
      idempotencyKey: invocation.memory.idempotencyKey,
      reportId: invocation.memory.reportId,
    });
    if (!memory) throw new Error("invalid weekly-report-memory file");
    const result = await transport.weeklyReportMemory(memory);
    return `Memory ${result.status} (report ${result.reportId}).`;
  }
  if (invocation.command === "action-prepare") return runActionPrepare(transport, invocation);
  if (isAttentionInvocation(invocation)) return runAttention(transport, invocation);
  if (invocation.command === "task-conversation") return runTaskConversation(transport, invocation);
  if (invocation.command === "channel-manage") return runChannelCommand(transport, invocation);
  if (invocation.command === "label") return runLabelCommand(transport, invocation);
  if (invocation.command === "inbox-check") return runInboxCheck(transport, invocation);
  if (invocation.command === "attachment-comments") {
    if (!transport.attachmentComments)
      throw new Error("Attachment comments transport is unavailable");
    return runAttachmentComments(transport.attachmentComments.bind(transport), invocation);
  }
  if (invocation.command === "attachment.view") {
    const result = await transport.view(invocation.attachmentId);
    await Bun.write(invocation.output, result.bytes);
    if (invocation.json)
      return JSON.stringify({ attachmentId: invocation.attachmentId, path: invocation.output });
    return formatAttachmentDownloadSuccess(invocation.output);
  }
  if (invocation.command === "attachment.upload") {
    if (!transport.upload) throw new Error("Attachment upload transport is unavailable");
    const { path, target } = await validateAttachmentUploadArgs(invocation);
    const mimeType = await inferAttachmentMimeType(path, invocation.mimeType);
    const result = await transport.upload({ path, target, mimeType });
    if (invocation.json) return JSON.stringify(result);
    return formatAttachmentUploadSuccess(result);
  }
  const { command } = invocation;
  if (command === "send") {
    const outputMode = invocation.json ? "json" : "text";
    if (invocation.sendDraft && (await sendDraftStdinHasContent())) {
      throw withOutputMode(
        new CliError({
          code: "SEND_DRAFT_STDIN_UNSUPPORTED",
          message: [
            "--send-draft sends the current saved draft and does not accept stdin.",
            "To update the draft, send the revised content normally without --send-draft:",
            `  coforge message send --target "${invocation.target}" <<'COFORGE_MESSAGE'`,
            "  revised message",
            "  COFORGE_MESSAGE",
          ].join("\n"),
          retryable: false,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        }),
        outputMode,
      );
    }
    if (!invocation.sendDraft)
      refuseForeignStdinFile(
        [
          `coforge message send --target "${invocation.target}" <<'COFORGE_MESSAGE'`,
          "reply body",
          "COFORGE_MESSAGE",
        ],
        { draftSaved: false, suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION, outputMode },
      );
    const body = invocation.sendDraft ? undefined : await readPipedSendContent();
    // With `--send-draft`, the body (and thus content presence) is only known to the daemon, which
    // already re-sends the draft's own saved mentions when no explicit override is given.
    if (invocation.mentions?.length && body !== undefined) {
      const present = mentionsInContent(body);
      for (const mention of invocation.mentions)
        if (!present.has(mention.name))
          throw withOutputMode(
            new CliError({
              code: "MENTION_NOT_IN_CONTENT",
              message: `Structured mention @${mention.name} is not present in the message body.`,
              retryable: false,
              draftSaved: false,
              suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
            }),
            outputMode,
          );
    }
    let result: unknown;
    try {
      result = await transport.send(invocation.target, body, {
        sendDraft: invocation.sendDraft,
        expectedDraftKey: invocation.expectedDraftKey,
        continueAnyway: invocation.continueAnyway,
        freshnessContextMode: invocation.freshnessContextMode,
        attachmentIds: invocation.attachmentIds,
        mentions: invocation.mentions,
        targetConfirmed: invocation.targetConfirmed,
      });
    } catch (error) {
      // The transport (`local-client.ts`) already redacts upstream detail for a withheld request;
      // this fallback only covers a transport that throws a bare `Error` without going through it.
      if (invocation.freshnessContextMode === "withheld" && !(error instanceof CliError))
        throw withOutputMode(
          new CliError({
            code: "SEND_FAILED",
            message: "Reviewer-isolation send failed; upstream response detail was withheld.",
            retryable: false,
            draftSaved: true,
            suggestedNextAction: unknownDeliveryNextAction(invocation.target),
          }),
          outputMode,
        );
      throw error instanceof CliError ? withOutputMode(error, outputMode) : error;
    }
    if (isHeldSend(result))
      throw withOutputMode(
        heldSendCliError(
          invocation.target,
          result as HeldSendResult,
          invocation.freshnessContextMode === "withheld",
        ),
        outputMode,
      );
    if (isCommittedSend(result))
      return invocation.json
        ? JSON.stringify({
            state: "committed",
            target: invocation.target,
            messageId: result.messageId,
            idempotencyKey: result.idempotencyKey,
            reconciliation: true,
            receiptComplete: false,
          })
        : formatSendCommitted(invocation.target, result.messageId);
    const sent = result as {
      messageId?: string;
      recentUnread?: AgentMessageRecord[];
      pendingMentionActions?: PendingMentionAction[];
      unresolvedMentionHandles?: string[];
      joinedChannel?: string;
    };
    const undelivered = undeliveredMentionError(invocation.target, sent, outputMode);
    if (invocation.json) {
      if (undelivered) throw undelivered;
      return JSON.stringify({
        state: "sent",
        target: invocation.target,
        messageId: sent.messageId,
        recentUnread: sent.recentUnread ?? [],
        ...(sent.joinedChannel ? { joinedChannel: sent.joinedChannel } : {}),
      });
    }
    if (undelivered) throw undelivered;
    return formatSendSuccess(invocation.target, sent, sent.recentUnread);
  }
  if (command === "continue") {
    if (!transport.continue) throw new Error("Message continue transport is unavailable");
    return runMessageContinue(invocation, transport.continue);
  }
  if (command === "search") {
    if (!transport.search) throw new Error("Message search transport is unavailable");
    const { command: _command, ...options } = invocation;
    const response = (await transport.search(options)) as {
      messages: AgentMessageRecord[];
      hasMore?: boolean;
      nextCursor?: string;
      incomplete?: boolean;
      searchedMessages?: number;
      searchedThrough?: string;
    };
    return formatSearchResults(options.query ?? "", response, options);
  }
  if (command === "resolve") {
    if (!transport.resolve) throw new Error("Message resolve transport is unavailable");
    return runMessageResolve(transport.resolve, invocation.messageId);
  }
  if (command === "react") {
    if (!transport.react) throw new Error("Message reaction transport is unavailable");
    await transport.react(invocation.messageId, invocation.emoji, invocation.remove === true);
    return formatReaction(invocation.messageId, invocation.emoji, invocation.remove === true);
  }
  if (command === "check") return formatMessageCheck(await transport.check(invocation.target));
  const readOptions = invocation.command === "read" ? invocation : undefined;
  const readResponse = (await transport.read(invocation.target, readOptions)) as {
    messages: AgentMessageRecord[];
    hasOlder?: boolean;
    hasNewer?: boolean;
    unreadCursorBefore?: number;
    readPositionAfter?: number;
    moreUnread?: boolean;
    foldedMessageCount?: number;
    foldedFromSequence?: number;
    foldedThroughSequence?: number;
  };
  return formatReadWindow(invocation.target, readResponse, {
    around: readOptions?.around,
    unread: readOptions?.unread,
  });
}
