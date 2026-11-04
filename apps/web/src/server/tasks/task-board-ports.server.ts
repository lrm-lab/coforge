import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { HumanNames } from "#src/lib/human-label";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import type { TaskReader } from "./task-view.server";

export type TaskBoardDependencies = {
  /** Who reads this board's command results: people (the default) or an Agent, through the Agent
   * Task route. A realtime Task copy always goes to people's pages. */
  reader?: TaskReader;
  realtime?: ConversationRealtime;
  notifications?: MessageNotifier;
  publisher?: Pick<CentrifugoServerApi, "publish" | "publishBatch">;
};

export type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** What `TaskBoard` hands each of its Task modules: the database, who reads its results, and the
 * publishers a write announces itself through after it commits. */
export type TaskBoardPorts = {
  db: PrismaClient;
  reader: TaskReader;
  dependencies: TaskBoardDependencies;
};

/** The acting conversation member; its user/Agent handle names it in Task history and notices. */
export type Member = {
  /** The member row's id; `null` for a Workspace owner/admin managing a public channel's Tasks
   * without a member row (task #512) — member-scoped writes (last-used Project, follow, the
   * sender's notice row) do not run for them. */
  id: string | null;
  userId: string | null;
  agentId: string | null;
  user?: HumanNames | null;
  agent?: {
    name: string;
    displayName?: string | null;
    /** The Agent's own server role; never inherited from its owner. */
    role?: string | null;
  } | null;
  /** The Project this member last filed a Task under in this conversation (task #484); a
   * person's web Task form defaults to it. */
};
/** The member a Task is assigned to: named in a notice by handle alone. */
/** The id a member-keyed write needs; a member-less admin is refused where one is required. */
export function memberId(member: Member): string {
  if (!member.id) throw new AppError("ACCESS_DENIED", { errorId: "task-needs-channel-member" });
  return member.id;
}

/** The key a request-id or receipt names a member-less admin with — an idempotency key, never
 * a member foreign key: writes that need the member row itself still use `memberId` or `member.id`. */
export function memberKey(member: Member): string {
  return member.id ?? `admin:${member.userId}`;
}

export type Assignee = Omit<Member, "user" | "agent"> & {
  user?: { username: string } | null;
  agent?: { name: string } | null;
};
export const MEMBER_SELECT = {
  id: true,
  userId: true,
  agentId: true,
  user: { select: { username: true, displayName: true } },
  agent: { select: { name: true, displayName: true, role: true } },
} satisfies Prisma.ConversationMemberSelect;
/** One conversation of one Workspace: where a Task lives and where its notices go. */
export type ConversationRef = { conversationId: string; workspaceId: string };
