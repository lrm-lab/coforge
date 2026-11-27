import { isValidMentionSelectorArray } from "@lrm/coforge-sdk/internal";
import { badRequest } from "./agent-proxy-body";
import { defineRoute } from "./agent-proxy-route";
import { exactPath } from "./agent-proxy-paths";
import { forwardResponse } from "./agent-proxy-response";
import {
  agentApiRoutes,
  type AgentTaskConversationRequest,
  type AgentTaskConversationRoute,
} from "@lrm/coforge-sdk/agent";

/** The local proxy's task conversation routes. Each is admitted as one `AgentTaskConversationRequest`
 * holding only the fields the route knows, and answered with the cloud's response as it came. */

const routes = agentApiRoutes.proxy.taskConversations;

const READ_QUERY = ["before", "after", "around", "limit", "unread"] as const;
const QUERY_FIELDS: Partial<Record<AgentTaskConversationRoute, readonly string[]>> = {
  view: ["limit"],
  read: READ_QUERY,
};
const BODY_FIELDS: Partial<Record<AgentTaskConversationRoute, readonly string[]>> = {
  reply: ["content", "idempotencyKey"],
  unfollow: ["reason"],
};
const REPLY_STRINGS = ["content", "idempotencyKey"];

/** The task the request names: a board (`#channel` or `dm:@peer`) and a task number. */
const isBoard = (value: unknown): value is string => typeof value === "string" && value !== "";
const isNumber = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

function queryRequest(
  route: AgentTaskConversationRoute,
  params: URLSearchParams,
): AgentTaskConversationRequest | Response {
  if (route === "following") return { route };
  const channel = params.get("channel");
  const number = params.get("task_number");
  if (!channel || !number || !isNumber(Number(number))) return badRequest();
  const query: Record<string, string> = { channel, task_number: number };
  for (const field of QUERY_FIELDS[route] ?? []) {
    const value = params.get(field);
    if (value !== null) query[field] = value;
  }
  return { route, query };
}

function bodyRequest(
  route: AgentTaskConversationRoute,
  fields: Record<string, unknown>,
): AgentTaskConversationRequest | Response {
  if (!isBoard(fields.channel) || !isNumber(fields.task_number)) return badRequest();
  const body: Record<string, unknown> = {
    channel: fields.channel,
    task_number: fields.task_number,
  };
  for (const field of BODY_FIELDS[route] ?? []) {
    const value = fields[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return badRequest();
    body[field] = value;
  }
  if (route === "reply") {
    if (fields.sendDraft === true) {
      if (
        fields.reconcileOnly !== undefined ||
        fields.holdIfUnread !== undefined ||
        fields.content !== undefined ||
        fields.idempotencyKey !== undefined ||
        fields.attachmentIds !== undefined ||
        fields.mentions !== undefined ||
        (fields.anyway !== undefined && typeof fields.anyway !== "boolean")
      )
        return badRequest();
      return {
        route,
        body: { ...body, sendDraft: true, ...(fields.anyway ? { anyway: true } : {}) },
      };
    }
    if (fields.sendDraft !== undefined || fields.anyway !== undefined) return badRequest();
    if (fields.holdIfUnread !== undefined) {
      if (typeof fields.holdIfUnread !== "boolean" || fields.reconcileOnly === true)
        return badRequest();
      body.holdIfUnread = fields.holdIfUnread;
    }
    if (fields.reconcileOnly !== undefined) {
      if (typeof fields.reconcileOnly !== "boolean") return badRequest();
      body.reconcileOnly = fields.reconcileOnly;
    }
    if (body.reconcileOnly === true) {
      if (
        typeof body.idempotencyKey !== "string" ||
        body.content !== undefined ||
        fields.attachmentIds !== undefined ||
        fields.mentions !== undefined
      )
        return badRequest();
      return { route, body };
    }
    if (fields.attachmentIds !== undefined) {
      const ids = fields.attachmentIds;
      if (!Array.isArray(ids) || ids.length > 10 || ids.some((id) => typeof id !== "string"))
        return badRequest();
      body.attachmentIds = ids;
    }
    if (fields.mentions !== undefined) {
      if (!isValidMentionSelectorArray(fields.mentions)) return badRequest();
      body.mentions = fields.mentions;
    }
    if (!REPLY_STRINGS.every((field) => typeof body[field] === "string")) return badRequest();
  }
  return { route, body };
}

const GET_ROUTES = ["view", "read", "following"] as const;
const POST_ROUTES = ["reply", "follow", "unfollow"] as const;

export const TASK_CONVERSATION_PROXY_ROUTES = [
  ...GET_ROUTES.map((route) =>
    defineRoute({
      family: `agent-api/task-${route}`,
      method: routes[route].method,
      match: exactPath(routes[route].path),
      body: "none",
      handler: "agentTaskConversation",
      parse: ({ url }) => queryRequest(route, url.searchParams),
      respond: forwardResponse,
    }),
  ),
  ...POST_ROUTES.map((route) =>
    defineRoute({
      family: `agent-api/task-${route}`,
      method: routes[route].method,
      match: exactPath(routes[route].path),
      body: "json-object",
      handler: "agentTaskConversation",
      parse: ({ fields }) => bodyRequest(route, fields),
      respond: forwardResponse,
    }),
  ),
];
