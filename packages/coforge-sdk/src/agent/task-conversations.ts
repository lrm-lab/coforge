/**
 * Wire contract for `coforge task view|read|reply|follow|unfollow|list --following`: the Agent
 * routes under `/api/agent/v1/tasks/` that serve a task's own conversation. The CLI sends a
 * request to the Daemon proxy and the Daemon forwards the same request to the cloud, so one
 * description of it serves both.
 */

import { isRecord } from "../internal";
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
  };
  /** The channel message the task was made from, when it was made from one. */
  sourceMessage?: {
    id: string;
    content: string;
    createdAt: string;
    senderName: string | null;
  } | null;
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
