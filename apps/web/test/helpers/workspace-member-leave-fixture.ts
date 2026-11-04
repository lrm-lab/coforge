import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { generalChannelForCreator } from "#src/server/conversations/general-channel.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { PrismaWorkspaceMemberDirectoryStore } from "#src/server/workspaces/member-directory-store.server";
import { WorkspaceMemberDirectory } from "#src/server/workspaces/member-directory.server";
import { admitWorkspaceMember } from "#src/server/workspaces/member-admission.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { quietCentrifugo } from "./fake-centrifugo";

export type Person = { id: string; username: string };

/** The channel-send tests' read/write fixture: workspace + Bob + the silent ports. */
export const channelTestConnectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
export const channelTestRedisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;

/** What the Agent message route needs to send a direct message, with realtime ignored. */
export const agentMessageDependencies = (
  repository: PrismaDirectConversationRepository,
  requestRecords: RedisMessageRequestIdempotency,
) => ({
  repository,
  requestRecords,
  sender: new SendDirectMessage(repository, requestRecords, quietCentrifugo()),
});

// Every send goes through request idempotency; these tests store each request once.
export const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };
// Member-list announcements have their own suite (`channel-member-changed.integration.test.ts`).
export const silentRealtime: ConversationRealtime = {
  async messageAvailable() {},
  async memberChanged() {},
};

export async function memberLeaveSetup() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: channelTestConnectionString! }),
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `ml-owner-${suffix}`, username: `ml-owner-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `ml-bob-${suffix}`, username: `ml-bob-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `ml-${suffix}`,
      name: "Member leave",
      members: { create: { userId: owner.id, role: "owner" } },
      conversations: generalChannelForCreator(owner.id),
    },
  });
  const directory = new WorkspaceMemberDirectory(
    new PrismaWorkspaceMemberDirectoryStore(db),
    silentRealtime,
  );
  const channels = new PublicChannels(
    db,
    passThrough,
    quietCentrifugo(),
    undefined,
    silentRealtime,
  );
  // Bob joins (again, after he has left) the way anyone is admitted.
  const admit = () =>
    db.$transaction((tx) =>
      admitWorkspaceMember(tx, { workspace, userId: bob.id, role: "member" }),
    );
  await admit();
  const team = await channels.create(workspace.id, owner.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  return { db, directory, channels, admit, workspace, owner, bob, team };
}

/** The Workspace `/` returns to, kept in memory the way the browser keeps its cookie. */
export function rememberedWorkspace(slug?: string) {
  const remembered = { slug };
  return {
    remembered,
    port: {
      read: () => remembered.slug,
      remember: (next: string) => {
        remembered.slug = next;
      },
      forget: () => {
        remembered.slug = undefined;
      },
    },
  };
}
