import { z } from "zod";

import {
  attachmentIdsSchema,
  mentionSelectorsSchema,
} from "#src/features/conversations/conversation.schemas";

import { AppError } from "#src/lib/app-error";
import { agentErrorResponse } from "#src/server/agents/agent-http-middleware.server";
import {
  readAgentJsonBody,
  agentRouteDomainErrorResponse,
} from "#src/server/agents/agent-http-routes.server";
import { MessageRequestInProgressError } from "#src/server/conversations/message-request-idempotency.server";
import type { TaskConversations } from "./task-conversations.server";
import type {
  AgentTaskIdleNudgeRequest,
  AgentTaskIdleNudgeResponse,
  AgentTaskViewResponse,
} from "@lrm/coforge-sdk/agent";
import type { AgentTaskPrincipal } from "./task-principal.server";

type Principal = AgentTaskPrincipal;

type Service = Pick<
  TaskConversations,
  "view" | "read" | "reply" | "follow" | "unfollow" | "following"
> &
  Partial<Pick<TaskConversations, "reconcileReply">>;

const refSchema = z.object({
  channel: z.string().min(1),
  task_number: z.number().int().positive(),
});
const replySchema = z.union([
  refSchema.extend({
    reconcileOnly: z.literal(true),
    idempotencyKey: z.string().min(1),
  }),
  refSchema.extend({
    reconcileOnly: z.literal(false).optional(),
    content: z.string().min(1).max(50_000),
    idempotencyKey: z.string().min(1),
    mentions: mentionSelectorsSchema,
    attachmentIds: attachmentIdsSchema,
  }),
]);
const limitSchema = z.coerce.number().int().min(1).max(20).optional();
const unfollowSchema = refSchema.extend({ reason: z.string().trim().min(1).max(200).optional() });

const asRef = (body: { channel: string; task_number: number }) => ({
  target: body.channel.replace(/^dm:/, ""),
  number: body.task_number,
});

function failure(error: unknown) {
  if (error instanceof z.ZodError)
    return Response.json({ error: "invalid task request", code: "INVALID_INPUT" }, { status: 400 });
  if (error instanceof MessageRequestInProgressError) return agentErrorResponse(error);
  if (error instanceof AppError && error.code === "ATTACHMENT_IN_OTHER_CONVERSATION")
    return agentErrorResponse(error);
  if (error instanceof AppError)
    return agentRouteDomainErrorResponse(error, "task request refused");
  console.error("[agent] Task conversation request failed", error);
  return Response.json({ error: "Task conversation request failed" }, { status: 500 });
}

function queryRef(request: Request) {
  const query = new URL(request.url).searchParams;
  return refSchema.parse({
    channel: query.get("channel") ?? "",
    task_number: Number(query.get("task_number")),
  });
}

export async function handleTaskViewGet(
  request: Request,
  principal: Principal,
  service: Service,
  recall?: (task: AgentTaskViewResponse["task"]) => Promise<AgentTaskViewResponse["relatedMemory"]>,
) {
  try {
    const ref = queryRef(request);
    const limit = limitSchema.parse(new URL(request.url).searchParams.get("limit") ?? undefined);
    const view = await service.view(principal, asRef(ref), { limit });
    const relatedMemory = await recall?.(view.task);
    return Response.json({ ...view, ...(relatedMemory?.length ? { relatedMemory } : {}) });
  } catch (error) {
    return failure(error);
  }
}

const readQuerySchema = z.object({
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  around: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unread: z.enum(["true", "false"]).optional(),
});

export async function handleTaskReadGet(request: Request, principal: Principal, service: Service) {
  try {
    const ref = queryRef(request);
    const query = new URL(request.url).searchParams;
    const page = readQuerySchema.parse(
      Object.fromEntries(
        ["before", "after", "around", "limit", "unread"].flatMap((name) =>
          query.has(name) ? [[name, query.get(name)]] : [],
        ),
      ),
    );
    const { unread, ...range } = page;
    return Response.json(
      await service.read(principal, asRef(ref), {
        ...range,
        ...(unread === "true" && { unread: true }),
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function handleTaskFollowingGet(principal: Principal, service: Service) {
  try {
    return Response.json({ tasks: await service.following(principal) });
  } catch (error) {
    return failure(error);
  }
}

export async function handleTaskReplyPost(
  request: Request,
  principal: Principal,
  service: Service,
) {
  try {
    const body = replySchema.parse(await readAgentJsonBody(request));
    if (body.reconcileOnly === true) {
      if (!service.reconcileReply)
        return Response.json({ state: "not_found", idempotencyKey: body.idempotencyKey });
      return Response.json({
        ...(await service.reconcileReply(principal, asRef(body), body.idempotencyKey)),
        idempotencyKey: body.idempotencyKey,
      });
    }
    return Response.json({
      ...(await service.reply(principal, asRef(body), {
        body: body.content,
        idempotencyKey: body.idempotencyKey,
        mentions: body.mentions,
        attachmentIds: body.attachmentIds,
      })),
      idempotencyKey: body.idempotencyKey,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function handleTaskFollowPost(
  request: Request,
  principal: Principal,
  service: Service,
) {
  try {
    const body = refSchema.parse(await readAgentJsonBody(request));
    return Response.json({ ok: true, ...(await service.follow(principal, asRef(body))) });
  } catch (error) {
    return failure(error);
  }
}

export async function handleTaskUnfollowPost(
  request: Request,
  principal: Principal,
  service: Service,
) {
  try {
    const body = unfollowSchema.parse(await readAgentJsonBody(request));
    return Response.json({
      ok: true,
      ...(await service.unfollow(principal, asRef(body), body.reason)),
    });
  } catch (error) {
    return failure(error);
  }
}

const idleNudgeSchema = z
  .object({
    freshSession: z.boolean().optional(),
    backgroundTasks: z.number().int().min(0).max(10_000).optional(),
    rulesShown: z.boolean().optional(),
  })
  .strict();

export async function handleTaskIdleNudgePost(
  request: Request,
  nudge: (input: AgentTaskIdleNudgeRequest) => Promise<AgentTaskIdleNudgeResponse>,
) {
  try {
    const body = idleNudgeSchema.parse((await readAgentJsonBody(request)) ?? {});
    return Response.json(await nudge(body));
  } catch (error) {
    return failure(error);
  }
}
