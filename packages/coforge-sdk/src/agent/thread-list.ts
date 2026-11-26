/**
 * Wire contract for `coforge thread list`: the threads the calling Agent follows. Raft also reports
 * why each is followed and when it was marked done; CoForge stores neither, so a follow is its
 * thread and the time it began.
 */

import { z } from "zod";

/** One followed channel thread: the target `message read` and `thread unfollow` take. */
export type AgentFollowedThread = {
  target: string;
  parentChannel: string;
  rootMessageId: string;
  followedAt: string;
};

/** Response for `GET /api/agent/v1/threads`: newest follow first. */
export type AgentThreadListResponse = {
  ok: true;
  threads: AgentFollowedThread[];
};

const followedThreadSchema = z.looseObject({
  target: z.string(),
  parentChannel: z.string(),
  rootMessageId: z.string(),
  followedAt: z.string(),
});

const threadListResponseSchema = z.object({
  ok: z.literal(true),
  threads: z.array(followedThreadSchema),
});

export function decodeAgentThreadListResponse(value: unknown): AgentThreadListResponse {
  const parsed = threadListResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent thread list response");
  return parsed.data;
}
