import { expect, spyOn, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { humanLabel, UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import {
  WorkspaceMemberDirectory,
  type WorkspaceMemberDirectoryStore,
  type WorkspaceMemberRecord,
} from "#src/server/workspaces/member-directory.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";

test("admin can change member roles but not ownership", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: adminId, role: "admin", username: "admin" });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "bob" });
  const directory = new WorkspaceMemberDirectory(store);

  await directory.updateRole({
    workspaceId,
    actorUserId: adminId,
    targetUserId: memberId,
    role: "admin",
  });
  expect(store.members.get(`${workspaceId}:${memberId}`)?.role).toBe("admin");

  await expect(
    directory.updateRole({
      workspaceId,
      actorUserId: adminId,
      targetUserId: ownerId,
      role: "admin",
    }),
  ).rejects.toBeInstanceOf(AppError);
});

test("owner cannot leave; admin can leave and be removed", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: adminId, role: "admin", username: "admin" });
  const directory = new WorkspaceMemberDirectory(store);

  await expect(directory.leave({ workspaceId, userId: ownerId })).rejects.toBeInstanceOf(AppError);
  await directory.leave({ workspaceId, userId: adminId });
  expect(store.members.has(`${workspaceId}:${adminId}`)).toBe(false);

  store.seedMember({ workspaceId, userId: adminId, role: "admin", username: "admin" });
  await directory.removeMember({
    workspaceId,
    actorUserId: ownerId,
    targetUserId: adminId,
  });
  expect(store.members.has(`${workspaceId}:${adminId}`)).toBe(false);
});

test("leaving or being removed tells each of the person's channels that its member list changed, and ends their subscriptions to them", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({
    workspaceId,
    userId: adminId,
    role: "admin",
    username: "admin",
    channelIds: ["channel-1"],
  });
  store.seedMember({
    workspaceId,
    userId: memberId,
    role: "member",
    username: "bob",
    channelIds: ["channel-1", "channel-2"],
  });
  const announced: Array<{ workspaceId: string; conversationIds: readonly string[] }> = [];
  const revoked: Array<{ conversationIds: readonly string[]; userIds: readonly string[] }> = [];
  const directory = new WorkspaceMemberDirectory(store, {
    memberChanged: async (input) => {
      announced.push(input);
    },
    revokeConversations: async (input) => {
      revoked.push(input);
    },
  });

  await directory.leave({ workspaceId, userId: adminId });
  await directory.removeMember({ workspaceId, actorUserId: ownerId, targetUserId: memberId });

  expect(announced).toEqual([
    { workspaceId, conversationIds: ["channel-1"] },
    { workspaceId, conversationIds: ["channel-1", "channel-2"] },
  ]);
  // Out of the Workspace they read none of its channels, public or private.
  expect(revoked).toEqual([
    { conversationIds: ["channel-1"], userIds: [adminId] },
    { conversationIds: ["channel-1", "channel-2"], userIds: [memberId] },
  ]);
});

test("leaving or being removed succeeds without Centrifugo, and tells only a member with Computers' daemons, best effort", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: adminId, role: "admin", username: "admin" });
  store.seedMember({
    workspaceId,
    userId: memberId,
    role: "member",
    username: "bob",
    computerIds: ["computer-1"],
  });
  // The production reconnect port, with no Centrifugo server API configured.
  const directory = new WorkspaceMemberDirectory(store, { memberChanged: async () => {} });
  const saved = {
    url: process.env.COFORGE_CENTRIFUGO_API_URL,
    key: process.env.COFORGE_CENTRIFUGO_API_KEY,
  };
  delete process.env.COFORGE_CENTRIFUGO_API_URL;
  delete process.env.COFORGE_CENTRIFUGO_API_KEY;
  const warnings: unknown[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line: unknown) => {
    warnings.push(JSON.parse(String(line)));
  });
  try {
    await directory.leave({ workspaceId, userId: adminId });
    expect(warnings).toEqual([]);
    await directory.removeMember({ workspaceId, actorUserId: ownerId, targetUserId: memberId });
    expect(warnings).toEqual([
      {
        event: "workspace_member:daemon_reconnect_failed",
        workspace_id: workspaceId,
        computer_count: 1,
        error_type: "Error",
      },
    ]);
    expect(store.members.has(`${workspaceId}:${adminId}`)).toBe(false);
    expect(store.members.has(`${workspaceId}:${memberId}`)).toBe(false);
  } finally {
    warn.mockRestore();
    if (saved.url !== undefined) process.env.COFORGE_CENTRIFUGO_API_URL = saved.url;
    if (saved.key !== undefined) process.env.COFORGE_CENTRIFUGO_API_KEY = saved.key;
  }
});

test("ordinary members can list peers", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "bob" });
  const directory = new WorkspaceMemberDirectory(store);

  const listed = await directory.listMembers({ workspaceId, actorUserId: memberId });
  expect(listed.map((row) => row.username).sort()).toEqual(["ada", "bob"]);
});

test("members are listed in the order of the names they are shown by, not of their usernames", async () => {
  const store = memoryStore();
  store.seedMember({
    workspaceId,
    userId: ownerId,
    role: "owner",
    username: "ada",
    displayName: "Zoe",
  });
  store.seedMember({
    workspaceId,
    userId: adminId,
    role: "admin",
    username: "zed",
    displayName: "Alice",
  });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "mia" });
  const directory = new WorkspaceMemberDirectory(store);

  const listed = await directory.listMembers({ workspaceId, actorUserId: ownerId });
  expect(listed.map((row) => row.username)).toEqual(["zed", "mia", "ada"]);
});

test("a member with no display name is listed as unnamed, never by their username", async () => {
  const store = memoryStore();
  store.seedMember({
    workspaceId,
    userId: ownerId,
    role: "owner",
    username: "ada",
  });
  store.seedMember({
    workspaceId,
    userId: adminId,
    role: "admin",
    username: "zed",
    displayName: "Alice",
  });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "mia" });
  const directory = new WorkspaceMemberDirectory(store);

  const listed = await directory.listMembers({ workspaceId, actorUserId: ownerId });
  expect(listed.map(humanLabel)).toEqual(["Alice", UNNAMED_PERSON_NAME, UNNAMED_PERSON_NAME]);
  // People shown alike keep a stable order by username, which is never shown.
  expect(listed.map((row) => row.username)).toEqual(["zed", "ada", "mia"]);
});

function memoryStore(): WorkspaceMemberDirectoryStore & {
  members: Map<string, WorkspaceMemberRecord>;
  /** The channels each `${workspaceId}:${userId}` member is active in. */
  channels: Map<string, string[]>;
  seedMember(input: {
    workspaceId: string;
    userId: string;
    role: WorkspaceMemberRole;
    username: string;
    displayName?: string;
    channelIds?: string[];
    computerIds?: string[];
  }): void;
} {
  const members = new Map<string, WorkspaceMemberRecord>();
  const channels = new Map<string, string[]>();
  const computers = new Map<string, string[]>();

  return {
    members,
    channels,
    seedMember(input) {
      channels.set(`${input.workspaceId}:${input.userId}`, input.channelIds ?? []);
      computers.set(`${input.workspaceId}:${input.userId}`, input.computerIds ?? []);
      members.set(`${input.workspaceId}:${input.userId}`, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        username: input.username,
        displayName: input.displayName ?? null,
        avatarUrl: null,
      });
    },
    async findMembership(workspaceId, userId) {
      return members.get(`${workspaceId}:${userId}`) ?? null;
    },
    async listMembers(workspaceId) {
      return [...members.values()]
        .filter((row) => row.workspaceId === workspaceId)
        .sort((a, b) => a.username.localeCompare(b.username));
    },
    async updateRole(workspaceId, userId, role: WorkspaceMemberRole) {
      const key = `${workspaceId}:${userId}`;
      const member = members.get(key);
      if (!member) throw new AppError("NOT_FOUND");
      member.role = role;
      return member;
    },
    async removeMember(workspaceId, userId) {
      const key = `${workspaceId}:${userId}`;
      members.delete(key);
      const leftChannelIds = channels.get(key) ?? [];
      channels.delete(key);
      const computerIds = computers.get(key) ?? [];
      computers.delete(key);
      return { leftChannelIds, revokedConversationIds: leftChannelIds, computerIds };
    },
  };
}
