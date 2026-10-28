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
  publisher?: Pick<CentrifugoServerApi, "publish">;
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
  id: string;
  userId: string | null;
  agentId: string | null;
  user?: HumanNames | null;
  agent?: { name: string; displayName?: string | null } | null;
};
/** The member a Task is assigned to: named in a notice by handle alone. */
export type Assignee = Omit<Member, "user" | "agent"> & {
  user?: { username: string } | null;
  agent?: { name: string } | null;
};
export const MEMBER_SELECT = {
  id: true,
  userId: true,
  agentId: true,
  user: { select: { username: true, displayName: true } },
  agent: { select: { name: true, displayName: true } },
} satisfies Prisma.ConversationMemberSelect;
/** One conversation of one Workspace: where a Task lives and where its notices go. */
export type ConversationRef = { conversationId: string; workspaceId: string };
