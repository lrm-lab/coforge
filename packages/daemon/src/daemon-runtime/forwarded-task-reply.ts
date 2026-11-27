import {
  agentTaskReplyHeldSchema,
  decodeAgentTaskReplyResponse,
  TASK_REPLY_RESUME_LEGACY_REFUSAL_NUMBER,
} from "@lrm/coforge-sdk/agent";
import { isValidMentionSelectorArray } from "@lrm/coforge-sdk/internal";
import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import { AgentPreflightError } from "./agent-preflight-error";

export type TaskReplyInbox = Pick<
  AgentInboxStateMachine,
  "lookup" | "save" | "clearIfIdempotencyKeyMatches"
>;

export async function forwardTaskReply(
  body: Record<string, unknown>,
  inbox: TaskReplyInbox,
  send: (body: Record<string, unknown>) => Promise<Response>,
) {
  const { channel, task_number: number } = body;
  const target = `task-reply:${channel}:#${number}`;
  let outbound = body;
  if (body.sendDraft === true) {
    const result = await inbox.lookup(target);
    if (result.status === "expired")
      throw new AgentPreflightError(
        "The saved task reply expired. Read the task before composing a replacement.",
        "SEND_DRAFT_EXPIRED",
        { retryable: false },
        {
          discarded_draft: {
            content: result.content,
            saved_at: new Date(result.savedAt).toISOString(),
          },
        },
      );
    if (result.status !== "found" || !result.draft.taskReplyId)
      throw new AgentPreflightError("No saved draft for this task.", "SEND_DRAFT_NOT_FOUND");
    const draft = result.draft;
    outbound = {
      channel,
      task_number: TASK_REPLY_RESUME_LEGACY_REFUSAL_NUMBER,
      resume: { number, taskId: draft.taskReplyId, anyway: body.anyway === true },
      content: draft.content,
      idempotencyKey: draft.idempotencyKey,
      ...(draft.attachmentIds ? { attachmentIds: draft.attachmentIds } : {}),
      ...(draft.mentions ? { mentions: draft.mentions } : {}),
    };
  }
  const response = await send(outbound);
  const { content, idempotencyKey, mentions, attachmentIds } = outbound;
  if (!response.ok || typeof content !== "string" || typeof idempotencyKey !== "string")
    return response;
  const raw: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const held = agentTaskReplyHeldSchema.safeParse(raw);
  if (held.success) {
    if (body.sendDraft !== true) {
      await inbox.save(target, {
        content,
        idempotencyKey,
        taskReplyId: held.data.taskId,
        ...(isValidMentionSelectorArray(mentions) ? { mentions } : {}),
        ...(Array.isArray(attachmentIds) ? { attachmentIds } : {}),
      });
    }
    return response;
  }
  if (body.sendDraft === true && isCommittedTaskReply(raw))
    await inbox.clearIfIdempotencyKeyMatches(target, idempotencyKey);
  return response;
}

function isCommittedTaskReply(raw: unknown): boolean {
  try {
    decodeAgentTaskReplyResponse(raw);
    return true;
  } catch {
    return false;
  }
}
