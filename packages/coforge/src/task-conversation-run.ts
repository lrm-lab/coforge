import type { AgentTaskConversationRequest } from "@lrm/coforge-sdk/agent";
import {
  decodeAgentTaskFollowResponse,
  decodeAgentTaskFollowingResponse,
  decodeAgentTaskReplyReconcileResponse,
  decodeAgentTaskReplyResponse,
  decodeAgentTaskViewResponse,
  isHistoryEventList,
} from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { CliError, withOutputMode } from "./cli-error";
import {
  convertLongMessageToAttachment,
  formatLongMessageConvertedSuffix,
} from "./long-message-attachment";
import { formatReadWindow, type ReadWindowResponse } from "./message-read-format";
import type { MessageTransport } from "./message-transport";
import type { TaskConversationInvocation } from "./task-conversation-args";
import {
  formatTaskFollow,
  formatTaskFollowing,
  formatTaskReply,
  formatTaskView,
} from "./task-conversation-format";
import { runReadConfirmationPage, type ReadConfirmationTransport } from "./read-confirmation";
import { readConfirmationPage } from "./message-read-args";
import { readPipedSendContent, refuseForeignStdinFile } from "./send-stdin";

export type TaskConversationTransport = ReadConfirmationTransport & {
  taskConversation?(request: AgentTaskConversationRequest): Promise<unknown>;
  upload?: MessageTransport["upload"];
};

const HEREDOC_DELIMITER = "COFORGE_MESSAGE";

function decoded<T>(decode: (value: unknown) => T, value: unknown): T {
  try {
    return decode(value);
  } catch (error) {
    throw new CliError({
      code: "INVALID_JSON_RESPONSE",
      message: error instanceof Error ? error.message : "invalid task response",
      retryable: false,
    });
  }
}

function decodeReadWindow(value: unknown): ReadWindowResponse {
  if (
    !isRecord(value) ||
    (value.messages !== undefined && !Array.isArray(value.messages)) ||
    (value.events !== undefined && !isHistoryEventList(value.events))
  )
    throw new Error("invalid Agent task read response");
  return value as ReadWindowResponse;
}

async function sendReply(
  send: (request: AgentTaskConversationRequest) => Promise<unknown>,
  body: Record<string, unknown>,
): Promise<{ raw: unknown; reconciled: boolean }> {
  try {
    return { raw: await send({ route: "reply", body }), reconciled: false };
  } catch (error) {
    if (!(error instanceof CliError && error.retryable)) throw error;
    let probe: unknown;
    try {
      probe = await send({
        route: "reply",
        body: {
          channel: body.channel,
          task_number: body.task_number,
          idempotencyKey: body.idempotencyKey,
          reconcileOnly: true,
        },
      });
    } catch (probeError) {
      if (probeError instanceof CliError && probeError.code === "INVALID_INPUT")
        return { raw: await send({ route: "reply", body }), reconciled: false };
      throw probeError;
    }
    const reconciled = (() => {
      try {
        return decodeAgentTaskReplyReconcileResponse(probe);
      } catch {
        return undefined;
      }
    })();
    if (reconciled?.state === "committed") return { raw: reconciled, reconciled: true };
    if (reconciled?.state === "not_found")
      return { raw: await send({ route: "reply", body }), reconciled: false };
    return { raw: probe, reconciled: false };
  }
}

async function runReply(
  send: (request: AgentTaskConversationRequest) => Promise<unknown>,
  invocation: Extract<TaskConversationInvocation, { op: "reply" }>,
  readBody: () => Promise<string>,
  upload?: MessageTransport["upload"],
): Promise<string> {
  const { task, json, mentions, attachmentIds } = invocation;
  const outputMode = json ? "json" : "text";
  const heredoc = [
    `coforge task reply "${task.ref}" <<'${HEREDOC_DELIMITER}'`,
    "reply body",
    HEREDOC_DELIMITER,
  ];
  try {
    refuseForeignStdinFile(heredoc, { outputMode });
    const content = (await readBody()).trim();
    if (!content)
      throw new CliError({
        code: "MISSING_CONTENT",
        message: [
          "No reply content received on stdin. Use a heredoc or pipe content into coforge task reply:",
          ...heredoc.map((line) => `  ${line}`),
        ].join("\n"),
        retryable: false,
        outputMode,
      });
    const absent = mentions?.find((mention) => !content.includes(`@${mention.name}`));
    if (absent)
      throw new CliError({
        code: "MENTION_NOT_IN_CONTENT",
        message: `Structured mention @${absent.name} is not present in the reply body.`,
        retryable: false,
        outputMode,
      });
    const converted = await convertLongMessageToAttachment({
      body: content,
      target: task.ref,
      existingAttachmentIds: attachmentIds,
      upload,
      outputMode,
    });
    const body = {
      channel: task.board,
      task_number: task.number,
      content: converted.body,
      idempotencyKey: crypto.randomUUID(),
      ...(mentions ? { mentions } : {}),
      ...(converted.attachmentIds ? { attachmentIds: converted.attachmentIds } : {}),
    };
    const outcome = await sendReply(send, body);
    const reply = decoded(decodeAgentTaskReplyResponse, outcome.raw);
    if (json) {
      return JSON.stringify({
        ok: true,
        data: reply,
        ...(converted.convertedAttachmentId
          ? { convertedToAttachmentId: converted.convertedAttachmentId }
          : {}),
      });
    }
    const base = `${formatTaskReply(task.ref, reply)}${formatLongMessageConvertedSuffix(converted.convertedAttachmentId)}`;
    return outcome.reconciled
      ? `${base}\nThe original response was lost, so delivery details are unavailable; the reply was not sent twice.`
      : base;
  } catch (error) {
    throw error instanceof CliError && json ? withOutputMode(error, "json") : error;
  }
}

/** Runs `coforge task view|reply|read|follow|unfollow|list --following` and returns what it prints. */
export async function runTaskConversation(
  transport: TaskConversationTransport,
  invocation: TaskConversationInvocation,
  readBody: () => Promise<string> = readPipedSendContent,
): Promise<string> {
  if (invocation.op === "read") {
    const { task, options } = invocation;
    const page = readConfirmationPage(
      { kind: "task", channel: task.board, taskNumber: task.number },
      options,
    );
    if (page) return runReadConfirmationPage(transport, page, task.ref);
  }
  const send = transport.taskConversation?.bind(transport);
  if (!send) throw new Error("Task conversation transport is unavailable");
  if (invocation.op === "following")
    return formatTaskFollowing(
      decoded(decodeAgentTaskFollowingResponse, await send({ route: "following" })),
    );
  if (invocation.op === "reply")
    return runReply(send, invocation, readBody, transport.upload?.bind(transport));
  const { task } = invocation;
  const ref = { channel: task.board, task_number: String(task.number) };
  switch (invocation.op) {
    case "view": {
      const query = { ...ref, ...(invocation.limit ? { limit: String(invocation.limit) } : {}) };
      return formatTaskView(
        decoded(decodeAgentTaskViewResponse, await send({ route: "view", query })),
      );
    }
    case "read": {
      const { before, after, around, limit, unread } = invocation.options;
      const query = {
        ...ref,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        ...(around ? { around } : {}),
        ...(limit ? { limit: String(limit) } : {}),
        ...(unread ? { unread: "true" } : {}),
      };
      const window = decoded(decodeReadWindow, await send({ route: "read", query }));
      return formatReadWindow(task.ref, window, { around, unread, task: true });
    }
    case "follow":
    case "unfollow": {
      const body = {
        channel: task.board,
        task_number: task.number,
        ...(invocation.op === "unfollow" && invocation.reason ? { reason: invocation.reason } : {}),
      };
      const result = decoded(
        decodeAgentTaskFollowResponse,
        await send({ route: invocation.op, body }),
      );
      return formatTaskFollow(task.ref, result);
    }
  }
}
