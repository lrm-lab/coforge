import type { AgentTaskConversationRequest } from "@lrm/coforge-sdk/agent";
import {
  decodeAgentTaskFollowResponse,
  decodeAgentTaskFollowingResponse,
  decodeAgentTaskReplyResponse,
  decodeAgentTaskViewResponse,
} from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { CliError, withOutputMode } from "./cli-error";
import { formatReadWindow, type ReadWindowResponse } from "./message-read-format";
import type { TaskConversationInvocation } from "./task-conversation-args";
import {
  formatTaskFollow,
  formatTaskFollowing,
  formatTaskReply,
  formatTaskView,
} from "./task-conversation-format";
import { readPipedSendContent, refuseForeignStdinFile } from "./send-stdin";

export type TaskConversationTransport = {
  taskConversation?(request: AgentTaskConversationRequest): Promise<unknown>;
};

const HEREDOC_DELIMITER = "COFORGE_MESSAGE";

/** A server answer that does not have the shape its route promises. */
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
  if (!isRecord(value) || (value.messages !== undefined && !Array.isArray(value.messages)))
    throw new Error("invalid Agent task read response");
  return value as ReadWindowResponse;
}

/** A reply that failed in transit, or at a 5xx, may or may not have been posted: the server
 * answers a repeat of the same key with the first reply, so one repeat cannot post it twice. */
async function sendReply(
  send: (request: AgentTaskConversationRequest) => Promise<unknown>,
  request: AgentTaskConversationRequest,
): Promise<unknown> {
  try {
    return await send(request);
  } catch (error) {
    if (!(error instanceof CliError && error.retryable)) throw error;
    return send(request);
  }
}

async function runReply(
  send: (request: AgentTaskConversationRequest) => Promise<unknown>,
  invocation: Extract<TaskConversationInvocation, { op: "reply" }>,
  readBody: () => Promise<string>,
): Promise<string> {
  const { task, json } = invocation;
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
    if (content.length > 50_000)
      throw new CliError({
        code: "INVALID_ARG",
        message: `The reply is at most 50000 characters; got ${content.length}.`,
        retryable: false,
        outputMode,
      });
    const body = {
      channel: task.board,
      task_number: task.number,
      content,
      idempotencyKey: crypto.randomUUID(),
    };
    const reply = decoded(
      decodeAgentTaskReplyResponse,
      await sendReply(send, { route: "reply", body }),
    );
    return json ? JSON.stringify({ ok: true, data: reply }) : formatTaskReply(task.ref, reply);
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
  const send = transport.taskConversation?.bind(transport);
  if (!send) throw new Error("Task conversation transport is unavailable");
  if (invocation.op === "following")
    return formatTaskFollowing(
      decoded(decodeAgentTaskFollowingResponse, await send({ route: "following" })),
    );
  if (invocation.op === "reply") return runReply(send, invocation, readBody);
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
