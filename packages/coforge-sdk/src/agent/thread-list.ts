/**
 * Wire contract for `coforge thread list`: the threads the calling Agent follows. Raft also reports
 * why each is followed and when it was marked done; CoForge stores neither, so a follow is its
 * thread and the time it began.
 */

import { isRecord } from "../internal";

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

function isFollowedThread(value: unknown): value is AgentFollowedThread {
  return (
    isRecord(value) &&
    typeof value.target === "string" &&
    typeof value.parentChannel === "string" &&
    typeof value.rootMessageId === "string" &&
    typeof value.followedAt === "string"
  );
}

export function decodeAgentThreadListResponse(value: unknown): AgentThreadListResponse {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.threads))
    throw new Error("invalid Agent thread list response");
  if (!value.threads.every(isFollowedThread)) throw new Error("invalid Agent thread list response");
  return { ok: true, threads: value.threads };
}
