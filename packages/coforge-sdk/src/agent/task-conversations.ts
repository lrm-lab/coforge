/**
 * Wire contract for `coforge task view|read|reply|follow|unfollow|list --following`: the Agent
 * routes under `/api/agent/v1/tasks/` that serve a task's own conversation. The CLI sends a
 * request to the Daemon proxy and the Daemon forwards the same request to the cloud, so one
 * description of it serves both.
 */

import { z } from "zod";
import type {
  TaskHistoryEvent,
  TaskPriority,
  TaskProjectRef,
  TaskResult,
  TaskStatus,
} from "../internal";
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
  relatedMemory?: TaskResult["relatedMemory"];
  task: {
    id: string;
    number: number;
    title: string;
    status: string;
    description?: string | null;
    owner?: { handle: string } | null;
    creator?: { handle: string };
    createdAt?: string;
    /** The Project it is filed under, null for none; absent from an older server. */
    project?: TaskProjectRef | null;
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
  earlierDiscussion?: { target: string; replyCount: number } | null;
  recentMessages: AgentTaskViewMessage[];
  /** The Task's history events among the latest entries; absent from an older server. Messages
   * and events together are at most `limit`, and `hasOlder` speaks for the merged stream. */
  recentEvents?: TaskHistoryEvent[];
  hasOlder: boolean;
};

/** What `GET /api/agent/v1/tasks/read` adds to a message window: the task's history events the
 * window owns; absent from an older server. */
export type AgentTaskReadEvents = { events?: TaskHistoryEvent[] };

/** Response for `POST /api/agent/v1/tasks/reply`. */
export type AgentTaskReplyResponse = {
  messageId: string;
  sequence: number;
  idempotencyKey?: string;
};

export const TASK_REPLY_RESUME_LEGACY_REFUSAL_NUMBER = 0;

export const agentTaskReplyHeldSchema = z.object({
  state: z.literal("held"),
  taskId: z.string().min(1),
  reason: z.literal("exact_target_pending"),
  newMessageCount: z.number().int().positive(),
  omittedMessageCount: z.number().int().nonnegative(),
  heldMessages: z.array(z.object({ sequence: z.number().int().positive(), body: z.string() })),
  idempotencyKey: z.string().min(1).optional(),
});

export type AgentTaskReplyHeld = z.infer<typeof agentTaskReplyHeldSchema>;

export type AgentTaskReplyReconcileResponse =
  | { state: "committed"; messageId: string; sequence: number; idempotencyKey?: string }
  | { state: "not_found"; idempotencyKey?: string };

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

const viewMessageSchema = z.looseObject({
  id: z.string(),
  sequence: z.number(),
  body: z.string(),
  createdAt: z.string(),
  sender: z.string().nullable(),
});

const historyEventSchema = z.looseObject({
  seq: z.number(),
  createdAt: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const historyEventListSchema = z.array(historyEventSchema);

const earlierDiscussionSchema = z.looseObject({
  target: z.string(),
  replyCount: z.int().min(0),
});

const taskViewResponseSchema = z.looseObject({
  taskRef: z.string(),
  task: z.looseObject({
    title: z.string(),
    status: z.string(),
  }),
  following: z.boolean(),
  followReason: z.string().nullable(),
  conversation: z.looseObject({
    exists: z.boolean(),
    replyCount: z.number(),
  }),
  earlierDiscussion: earlierDiscussionSchema.nullish(),
  recentMessages: z.array(viewMessageSchema),
  recentEvents: historyEventListSchema.optional(),
  hasOlder: z.boolean(),
});

const taskReplyResponseSchema = z.looseObject({
  messageId: z.string(),
  sequence: z.number(),
});

const taskReplyReconcileResponseSchema = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("not_found") }),
  z.looseObject({
    state: z.literal("committed"),
    messageId: z.string(),
    sequence: z.number(),
  }),
]);

const taskFollowResponseSchema = z.looseObject({
  ok: z.literal(true),
  taskRef: z.string(),
  following: z.boolean(),
  changed: z.boolean(),
});

const followedTaskSchema = z.looseObject({
  taskRef: z.string(),
  title: z.string(),
  status: z.string(),
  unread: z.number(),
  reason: z.string(),
});

const taskFollowingResponseSchema = z.looseObject({
  tasks: z.array(followedTaskSchema),
});

export function isHistoryEventList(value: unknown): value is TaskHistoryEvent[] {
  return historyEventListSchema.safeParse(value).success;
}

export function decodeAgentTaskViewResponse(value: unknown): AgentTaskViewResponse {
  const parsed = taskViewResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent task view response");
  return parsed.data as AgentTaskViewResponse;
}

export function decodeAgentTaskReplyResponse(value: unknown): AgentTaskReplyResponse {
  const parsed = taskReplyResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent task reply response");
  return parsed.data as AgentTaskReplyResponse;
}

export function decodeAgentTaskReplyReconcileResponse(
  value: unknown,
): AgentTaskReplyReconcileResponse {
  const parsed = taskReplyReconcileResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent task reply reconcile response");
  return parsed.data as AgentTaskReplyReconcileResponse;
}

export function decodeAgentTaskFollowResponse(value: unknown): AgentTaskFollowResponse {
  const parsed = taskFollowResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent task follow response");
  return parsed.data;
}

export function decodeAgentTaskFollowingResponse(value: unknown): AgentTaskFollowingResponse {
  const parsed = taskFollowingResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent followed tasks response");
  return parsed.data;
}

export type AgentTaskIdleNudgeRequest = {
  freshSession?: boolean;
  backgroundTasks?: number;
  rulesShown?: boolean;
};
export type AgentTaskIdleReason = "new_session" | "newly_assigned" | "others_acted" | "stale";
export type AgentTaskIdleSkipReason = "disabled" | "no_open_tasks" | "no_change" | "hourly_cap";
export type AgentTaskIdleItem = {
  ref: string;
  taskNumber: number;
  channel: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  reason: AgentTaskIdleReason;
  why: string;
  queuePosition?: number;
};
export type AgentTaskIdleNudgeResponse = {
  send: boolean;
  reason?: AgentTaskIdleSkipReason;
  rules?: boolean;
  items: AgentTaskIdleItem[];
  backlog: { ref: string; title: string }[];
  text: string;
};

const idleItemSchema = z.looseObject({
  ref: z.string(),
  taskNumber: z.number(),
  channel: z.string(),
  title: z.string(),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "closed"]),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]),
  reason: z.enum(["new_session", "newly_assigned", "others_acted", "stale"]),
  why: z.string(),
  queuePosition: z.int().min(1).optional(),
});

const idleBacklogItemSchema = z.looseObject({
  ref: z.string(),
  title: z.string(),
});

const taskIdleNudgeResponseSchema = z.looseObject({
  send: z.boolean(),
  reason: z.enum(["disabled", "no_open_tasks", "no_change", "hourly_cap"]).optional(),
  rules: z.boolean().optional(),
  items: z.array(idleItemSchema),
  backlog: z.array(idleBacklogItemSchema),
  text: z.string(),
});

export function decodeAgentTaskIdleNudgeResponse(value: unknown): AgentTaskIdleNudgeResponse {
  const parsed = taskIdleNudgeResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent task idle-nudge response");
  return parsed.data;
}
