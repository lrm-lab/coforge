import { expect, test } from "bun:test";
import { canReadConversationHome } from "#src/server/conversations/channel-read-access.server";
import { ArtifactReads } from "#src/server/artifacts/artifact-reads.server";

const ids = Array.from(
  { length: 20 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

test("artifact home access shares one matrix for channels and DMs", () => {
  const cases = [
    [{ channelName: "general", visibility: "public", member: false }, true],
    [{ channelName: "secret", visibility: "private", member: true }, true],
    [{ channelName: "secret", visibility: "private", member: false }, false],
    [{ channelName: null, visibility: "private", member: true }, true],
    [{ channelName: null, visibility: "private", member: false }, false],
  ] as const;
  for (const [input, expected] of cases) expect(canReadConversationHome(input)).toBe(expected);
});

test("a message page projects twenty artifact links with three batch reads", async () => {
  const calls: string[] = [];
  const db = {
    artifact: {
      findMany: async () => {
        calls.push("artifacts");
        return ids.map((id) => ({
          id,
          title: `Artifact ${id.slice(-2)}`,
          preview: "first line\nsecond line",
          kind: "markdown",
          currentVersion: 2,
          homeKey: "workspace",
          access: "conversation",
          deletedAt: null,
          authorAgentId: "agent-secret",
          workspace: { slug: "docs" },
        }));
      },
    },
    workspaceMembership: {
      findUnique: async () => {
        calls.push("membership");
        return { userId: "user-1" };
      },
    },
    conversation: {
      findMany: async () => {
        calls.push("conversations");
        return [];
      },
    },
  };
  const reads = new ArtifactReads(db as never, async () => true);
  const result = await reads.messageCards({
    workspaceId: "workspace-1",
    reader: { userId: "user-1" },
    messages: [{ body: ids.map((id) => `/w/docs/artifacts/${id}`).join("\n") }],
  });

  expect(calls).toEqual(["artifacts", "membership", "conversations"]);
  expect(result[0]).toHaveLength(20);
  expect(result[0]![0]).toMatchObject({
    state: "open",
    artifactId: ids[0],
    title: `Artifact ${ids[0]!.slice(-2)}`,
    canOpen: true,
  });
});

test("a reader without the artifact's existing access gets a redacted card", async () => {
  const id = ids[0]!;
  const db = {
    artifact: {
      findMany: async () => [
        {
          id,
          title: "Private title",
          preview: "private preview",
          kind: "markdown",
          currentVersion: 1,
          homeKey: "conversation:private-1",
          access: "conversation",
          deletedAt: null,
          authorAgentId: null,
          workspace: { slug: "docs" },
        },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    conversation: {
      findMany: async () => [
        {
          id: "private-1",
          channelName: "secret",
          visibility: "private",
          hiddenFromWorkspaceAt: null,
          members: [],
        },
      ],
    },
  };
  const reads = new ArtifactReads(db as never, async () => true);
  const [card] = (
    await reads.messageCards({
      workspaceId: "workspace-1",
      reader: { userId: "user-1" },
      messages: [{ body: `/w/docs/artifacts/${id}` }],
    })
  )[0]!;
  expect(card).toEqual({ kind: "artifact", state: "forbidden", artifactId: id, canOpen: false });
});

test("message cards do not reveal deletion to a reader without home access", async () => {
  const inaccessible = ids[1]!;
  const readable = ids[2]!;
  const db = {
    artifact: {
      findMany: async () => [
        {
          id: inaccessible,
          title: "Hidden deleted",
          preview: "private",
          kind: "markdown",
          currentVersion: 1,
          homeKey: "conversation:private-2",
          access: "conversation",
          deletedAt: new Date(),
          authorAgentId: "agent-secret",
          workspace: { slug: "docs" },
        },
        {
          id: readable,
          title: "Visible deleted",
          preview: "visible",
          kind: "markdown",
          currentVersion: 1,
          homeKey: "workspace",
          access: "workspace",
          deletedAt: new Date(),
          authorAgentId: "agent-secret",
          workspace: { slug: "docs" },
        },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    conversation: {
      findMany: async () => [
        {
          id: "private-2",
          channelName: "secret",
          visibility: "private",
          hiddenFromWorkspaceAt: null,
          members: [],
        },
      ],
    },
  };
  const reads = new ArtifactReads(db as never, async () => true);
  const [hidden, visible] = (
    await reads.messageCards({
      workspaceId: "workspace-1",
      reader: { userId: "user-1" },
      messages: [
        {
          body: `/w/docs/artifacts/${inaccessible}\n/w/docs/artifacts/${readable}`,
        },
      ],
    })
  )[0]!;
  expect(hidden).toEqual({
    kind: "artifact",
    state: "forbidden",
    artifactId: inaccessible,
    canOpen: false,
  });
  expect(visible).toEqual({
    kind: "artifact",
    state: "deleted",
    artifactId: readable,
    canOpen: false,
  });
});

test("a page without artifact links does not read the artifacts experiment", async () => {
  let enabledCalls = 0;
  const reads = new ArtifactReads({} as never, async () => {
    enabledCalls += 1;
    return true;
  });
  expect(
    await reads.messageCards({
      workspaceId: "workspace-1",
      reader: { userId: "user-1" },
      messages: [{ body: "ordinary message" }],
    }),
  ).toEqual([[]]);
  expect(enabledCalls).toBe(0);
});

test("a hidden channel artifact stays forbidden in message cards", async () => {
  const id = ids[3]!;
  const db = {
    artifact: {
      findMany: async () => [
        {
          id,
          title: "Hidden channel",
          preview: "private",
          kind: "markdown",
          currentVersion: 1,
          homeKey: "conversation:hidden-1",
          access: "conversation",
          deletedAt: null,
          authorAgentId: null,
          workspace: { slug: "docs" },
        },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    conversation: {
      findMany: async () => [
        {
          id: "hidden-1",
          channelName: "general",
          visibility: "public",
          hiddenFromWorkspaceAt: new Date(),
          members: [{ id: "member" }],
        },
      ],
    },
  };
  const reads = new ArtifactReads(db as never, async () => true);
  const [card] = (
    await reads.messageCards({
      workspaceId: "workspace-1",
      reader: { userId: "user-1" },
      messages: [{ body: `/w/docs/artifacts/${id}` }],
    })
  )[0]!;
  expect(card).toEqual({ kind: "artifact", state: "forbidden", artifactId: id, canOpen: false });
});
