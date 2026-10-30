import { z } from "zod";

import { AppError } from "#src/lib/app-error";
import {
  readAgentJsonBody,
  agentRouteDomainErrorResponse,
} from "#src/server/agents/agent-http-routes.server";
import type { TaskConversations } from "./task-conversations.server";

/**
 * The Agent HTTP adapters for task conversations. They validate the request's shape and map a
 * refusal to its status; the service owns authorization (the reader sees the task's channel).
 */
type Principal = { workspaceId: string; agentId: string };
type Service = Pick<TaskConversations, "view" | "reply" | "follow" | "unfollow" | "following">;

const refSchema = z.object({
  channel: z.string().min(1),
  task_number: z.number().int().positive(),
});
const replySchema = refSchema.extend({
  content: z.string().min(1).max(50_000),
  idempotencyKey: z.string().min(1),
});
const unfollowSchema = refSchema.extend({ reason: z.string().trim().min(1).max(200).optional() });

const asRef = (body: { channel: string; task_number: number }) => ({
  target: body.channel,
  number: body.task_number,
});

function failure(error: unknown) {
  if (error instanceof z.ZodError)
    return Response.json({ error: "invalid task request", code: "INVALID_INPUT" }, { status: 400 });
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

export async function handleTaskViewGet(request: Request, principal: Principal, service: Service) {
  try {
    const ref = queryRef(request);
    const limit = new URL(request.url).searchParams.get("limit");
    return Response.json(
      await service.view(principal, asRef(ref), { limit: limit ? Number(limit) : undefined }),
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
    return Response.json({
      ...(await service.reply(principal, asRef(body), { body: body.content })),
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
