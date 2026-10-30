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

/** Whether the Agent's owner has task conversations on (the `taskConversations` experiment). */
export type TaskConversationsGate = () => Promise<boolean>;

const OFF_MESSAGE =
  "Task conversations are not turned on for this Agent's owner. Turn on Task conversations in Settings → Experiments to use this command.";
type Service = Pick<TaskConversations, "view" | "reply" | "follow" | "unfollow" | "following">;

const refSchema = z.object({
  channel: z.string().min(1),
  task_number: z.number().int().positive(),
});
const replySchema = refSchema.extend({
  content: z.string().min(1).max(50_000),
  idempotencyKey: z.string().min(1),
});
const limitSchema = z.coerce.number().int().min(1).max(20).optional();
const unfollowSchema = refSchema.extend({ reason: z.string().trim().min(1).max(200).optional() });

/** A direct board is named `dm:@peer` on the wire; the board resolves it as `@peer`. */
const asRef = (body: { channel: string; task_number: number }) => ({
  target: body.channel.replace(/^dm:/, ""),
  number: body.task_number,
});

class TaskConversationsOff extends Error {}

/** The experiment decides for the Agent's owner; with it off the routes answer as if absent. */
async function requireOn(gate: TaskConversationsGate) {
  if (!(await gate())) throw new TaskConversationsOff();
}

function failure(error: unknown) {
  if (error instanceof TaskConversationsOff)
    return Response.json({ error: OFF_MESSAGE, code: "task_conversations_off" }, { status: 404 });
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

export async function handleTaskViewGet(
  request: Request,
  principal: Principal,
  service: Service,
  gate: TaskConversationsGate,
) {
  try {
    await requireOn(gate);
    const ref = queryRef(request);
    const limit = limitSchema.parse(new URL(request.url).searchParams.get("limit") ?? undefined);
    return Response.json(await service.view(principal, asRef(ref), { limit }));
  } catch (error) {
    return failure(error);
  }
}

export async function handleTaskFollowingGet(
  principal: Principal,
  service: Service,
  gate: TaskConversationsGate,
) {
  try {
    await requireOn(gate);
    return Response.json({ tasks: await service.following(principal) });
  } catch (error) {
    return failure(error);
  }
}

export async function handleTaskReplyPost(
  request: Request,
  principal: Principal,
  service: Service,
  gate: TaskConversationsGate,
) {
  try {
    await requireOn(gate);
    const body = replySchema.parse(await readAgentJsonBody(request));
    return Response.json({
      ...(await service.reply(principal, asRef(body), {
        body: body.content,
        idempotencyKey: body.idempotencyKey,
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
  gate: TaskConversationsGate,
) {
  try {
    await requireOn(gate);
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
  gate: TaskConversationsGate,
) {
  try {
    await requireOn(gate);
    const body = unfollowSchema.parse(await readAgentJsonBody(request));
    return Response.json({
      ok: true,
      ...(await service.unfollow(principal, asRef(body), body.reason)),
    });
  } catch (error) {
    return failure(error);
  }
}
