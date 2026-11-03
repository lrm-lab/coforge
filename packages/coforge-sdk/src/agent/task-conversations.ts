/**
 * Wire contract for `coforge task view|read|reply|follow|unfollow|list --following`: the Agent
 * routes under `/api/agent/v1/tasks/` that serve a task's own conversation. The CLI sends a
 * request to the Daemon proxy and the Daemon forwards the same request to the cloud, so one
 * description of it serves both.
 */

import { isRecord, type TaskPriority, type TaskStatus } from "../internal";
import type { agentApiRoutes } from "./routes";

export type AgentTaskConversationRoutes = typeof agentApiRoutes.cloud.taskConversations;
export type AgentTaskConversationRoute = keyof AgentTaskConversationRoutes;

/** One request to a task conversation route: a GET names its parameters in `query`, a POST its
 * JSON `body`. The board is `channel` (`#channel` or `dm:@peer`) and the task `task_number`. */
export type AgentTaskConversationRequest = {
  route: AgentTaskConversationRoute;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

/** The method, path (with its query) and JSON body `request` becomes on `routes`. */
export function taskConversationHttpRequest(
  routes: AgentTaskConversationRoutes,
  request: AgentTaskConversationRequest,
): { method: string; path: string; body?: string } {
  const { method, path } = routes[request.route];
  const query = request.query ? new URLSearchParams(request.query).toString() : "";
  return {
    method,
    path: query ? `${path}?${query}` : path,
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  };
}

/** One message of a task's conversation, as `task view` lists it; `sender` is null for a notice
 * the server posted. */
export type AgentTaskViewMessage = {
  id: string;
  sequence: number;
  body: string;
  createdAt: string;
  sender: string | null;
};

/** Response for `GET /api/agent/v1/tasks/view`. */
export type AgentTaskViewResponse = {
  taskRef: string;
  task: {
    id: string;
    number: number;
    title: string;
    status: string;
    description?: string | null;
    owner?: { handle: string } | null;
    creator?: { handle: string };
    createdAt?: string;
    sourceMessage?: {
      messageId: string;
      threadRootId?: string;
      senderName: string | null;
      preview: string;
    } | null;
  };
  following: boolean;
  followReason: string | null;
  conversation: { exists: boolean; replyCount: number };
  recentMessages: AgentTaskViewMessage[];
  hasOlder: boolean;
};

/** Response for `POST /api/agent/v1/tasks/reply`. */
export type AgentTaskReplyResponse = {
  messageId: string;
  sequence: number;
  idempotencyKey?: string;
};

/** Response for `POST /api/agent/v1/tasks/follow` and `/unfollow`; `changed` is false when the
 * Agent already was (or was not) following. */
export type AgentTaskFollowResponse = {
  ok: true;
  taskRef: string;
  following: boolean;
  changed: boolean;
};

/** One followed task conversation, newest follow first. */
export type AgentFollowedTask = {
  taskRef: string;
  taskNumber?: number;
  title: string;
  status: string;
  unread: number;
  followedAt?: string;
  reason: string;
};

/** Response for `GET /api/agent/v1/tasks/following`. */
export type AgentTaskFollowingResponse = { tasks: AgentFollowedTask[] };

const isString = (value: unknown): value is string => typeof value === "string";

function isViewMessage(value: unknown): value is AgentTaskViewMessage {
  return (
    isRecord(value) &&
    isString(value.id) &&
    typeof value.sequence === "number" &&
    isString(value.body) &&
    isString(value.createdAt) &&
    (value.sender === null || isString(value.sender))
  );
}

export function decodeAgentTaskViewResponse(value: unknown): AgentTaskViewResponse {
  if (
    !isRecord(value) ||
    !isString(value.taskRef) ||
    !isRecord(value.task) ||
    !isString(value.task.title) ||
    !isString(value.task.status) ||
    typeof value.following !== "boolean" ||
    !(value.followReason === null || isString(value.followReason)) ||
    !isRecord(value.conversation) ||
    typeof value.conversation.exists !== "boolean" ||
    typeof value.conversation.replyCount !== "number" ||
    !Array.isArray(value.recentMessages) ||
    !value.recentMessages.every(isViewMessage) ||
    typeof value.hasOlder !== "boolean"
  )
    throw new Error("invalid Agent task view response");
  return value as AgentTaskViewResponse;
}

export function decodeAgentTaskReplyResponse(value: unknown): AgentTaskReplyResponse {
  if (!isRecord(value) || !isString(value.messageId) || typeof value.sequence !== "number")
    throw new Error("invalid Agent task reply response");
  return value as AgentTaskReplyResponse;
}

export function decodeAgentTaskFollowResponse(value: unknown): AgentTaskFollowResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isString(value.taskRef) ||
    typeof value.following !== "boolean" ||
    typeof value.changed !== "boolean"
  )
    throw new Error("invalid Agent task follow response");
  return value as AgentTaskFollowResponse;
}

function isFollowedTask(value: unknown): value is AgentFollowedTask {
  return (
    isRecord(value) &&
    isString(value.taskRef) &&
    isString(value.title) &&
    isString(value.status) &&
    typeof value.unread === "number" &&
    isString(value.reason)
  );
}

export function decodeAgentTaskFollowingResponse(value: unknown): AgentTaskFollowingResponse {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !value.tasks.every(isFollowedTask))
    throw new Error("invalid Agent followed tasks response");
  return value as AgentTaskFollowingResponse;
}

/** Request of `POST /api/agent/v1/tasks/idle-nudge`: a fresh session's first idle, and how many
 * background tasks the Agent still runs (0 to 10000). */
export type AgentTaskIdleNudgeRequest = { freshSession?: boolean; backgroundTasks?: number };
/** Why a Task is in an idle reminder. */
export type AgentTaskIdleReason = "new_session" | "newly_assigned" | "others_acted" | "stale";
/** Why no idle reminder is sent. */
export type AgentTaskIdleSkipReason = "disabled" | "no_open_tasks" | "no_change" | "hourly_cap";
export type AgentTaskIdleItem = {
  ref: string;
  taskNumber: number;
  channel: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  reason: AgentTaskIdleReason;
  /** Why, in English, as the text says it. */
  why: string;
};
/** Response of `POST /api/agent/v1/tasks/idle-nudge`: with `send`, give the Agent `text`. */
export type AgentTaskIdleNudgeResponse = {
  send: boolean;
  reason?: AgentTaskIdleSkipReason;
  items: AgentTaskIdleItem[];
  backlog: { ref: string; title: string }[];
  text: string;
};

const IDLE_REASONS: ReadonlySet<string> = new Set<AgentTaskIdleReason>([
  "new_session",
  "newly_assigned",
  "others_acted",
  "stale",
]);
const IDLE_SKIP_REASONS: ReadonlySet<string> = new Set<AgentTaskIdleSkipReason>([
  "disabled",
  "no_open_tasks",
  "no_change",
  "hourly_cap",
]);
const TASK_STATUS_VALUES: ReadonlySet<string> = new Set<TaskStatus>([
  "todo",
  "in_progress",
  "in_review",
  "done",
  "closed",
]);
const TASK_PRIORITY_VALUES: ReadonlySet<string> = new Set<TaskPriority>([
  "urgent",
  "high",
  "medium",
  "low",
  "none",
]);

function isIdleItem(value: unknown): value is AgentTaskIdleItem {
  return (
    isRecord(value) &&
    isString(value.ref) &&
    typeof value.taskNumber === "number" &&
    isString(value.channel) &&
    isString(value.title) &&
    isString(value.status) &&
    TASK_STATUS_VALUES.has(value.status) &&
    isString(value.priority) &&
    TASK_PRIORITY_VALUES.has(value.priority) &&
    isString(value.reason) &&
    IDLE_REASONS.has(value.reason) &&
    isString(value.why)
  );
}

function isIdleBacklogItem(value: unknown): value is { ref: string; title: string } {
  return isRecord(value) && isString(value.ref) && isString(value.title);
}

/**
 * Validates `POST /api/agent/v1/tasks/idle-nudge`'s answer before the daemon writes its `text` as
 * input: an unknown reason or a malformed item would otherwise reach the Agent as a broken
 * reminder.
 */
export function decodeAgentTaskIdleNudgeResponse(value: unknown): AgentTaskIdleNudgeResponse {
  if (
    !isRecord(value) ||
    typeof value.send !== "boolean" ||
    !Array.isArray(value.items) ||
    !value.items.every(isIdleItem) ||
    !Array.isArray(value.backlog) ||
    !value.backlog.every(isIdleBacklogItem) ||
    !isString(value.text) ||
    (value.reason !== undefined && !(isString(value.reason) && IDLE_SKIP_REASONS.has(value.reason)))
  )
    throw new Error("invalid Agent task idle-nudge response");
  return value as AgentTaskIdleNudgeResponse;
}
