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
        return ids.map((id, index) => ({
          id,
          title: `Artifact ${id.slice(-2)}`,
          preview: "first line\nsecond line",
          kind: "markdown",
          currentVersion: 2,
          homeKey: index === 0 ? `conversation:${ids[19]}` : "workspace",
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
        return [
          {
            id: ids[19],
            channelName: "open",
            visibility: "public",
            hiddenFromWorkspaceAt: null,
            members: [{ id: "member" }],
          },
        ];
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

test("a member reads the card but never learns the private home it came from", async () => {
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
          homeKey: `conversation:${ids[5]}`,
          deletedAt: null,
          authorAgentId: "agent-1",
          workspace: { slug: "docs" },
        },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    conversation: {
      findMany: async () => [
        {
          id: ids[5],
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
  // Every member reads it (task #20); the source names the author, never the private channel.
  expect(card).toEqual({
    kind: "artifact",
    state: "open",
    artifactId: id,
    href: "/w/docs/artifacts/" + id,
    title: "Private title",
    preview: "private preview",
    contentType: "markdown",
    version: 1,
    source: { agentId: "agent-1", label: "Agent" },
    canOpen: true,
  });
});

test("a non-member's card stays forbidden", async () => {
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
          homeKey: `conversation:${ids[6]}`,
          deletedAt: null,
          authorAgentId: null,
          workspace: { slug: "docs" },
        },
      ],
    },
    workspaceMembership: { findUnique: async () => null },
    conversation: {
      findMany: async () => [
        {
          id: ids[6],
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

test("a non-member's card of a public channel's artifact stays forbidden too", async () => {
  const id = ids[10]!;
  const db = {
    artifact: {
      findMany: async () => [
        {
          id,
          title: "Public channel artifact",
          preview: "preview",
          kind: "markdown",
          currentVersion: 1,
          homeKey: `conversation:${ids[11]}`,
          deletedAt: null,
          authorAgentId: null,
          workspace: { slug: "docs" },
        },
      ],
    },
    workspaceMembership: { findUnique: async () => null },
    conversation: {
      findMany: async () => [
        {
          id: ids[11],
          channelName: "open",
          visibility: "public",
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
  // The home's readers include everyone for a public channel, but the card still asks the
  // Workspace membership `read` asks for (task #20).
  expect(card).toEqual({ kind: "artifact", state: "forbidden", artifactId: id, canOpen: false });
});

test("message cards show a member the deletion state of any artifact", async () => {
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
          homeKey: `conversation:${ids[7]}`,
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
          id: ids[7],
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
  // Every member reads every artifact (task #20), so its deletion is theirs to see — the card
  // carries no title or preview either way.
  expect(hidden).toEqual({
    kind: "artifact",
    state: "deleted",
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

test("a hidden channel's artifact is forbidden even to a member", async () => {
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
          homeKey: `conversation:${ids[8]}`,
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
          id: ids[8],
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
  // A home the Workspace hides is gone for everyone, its cards with it (task #20).
  expect(card).toEqual({ kind: "artifact", state: "forbidden", artifactId: id, canOpen: false });
});

test("an Agent of the Workspace reads the card like a member", async () => {
  const id = ids[4]!;
  const db = {
    artifact: {
      findMany: async () => [
        {
          id,
          title: "Agent read",
          preview: "preview",
          kind: "markdown",
          currentVersion: 1,
          homeKey: `conversation:${ids[9]}`,
          deletedAt: null,
          authorAgentId: "agent-1",
          workspace: { slug: "docs" },
        },
      ],
    },
    agent: { findFirst: async () => ({ id: "agent-9" }) },
    conversation: {
      findMany: async () => [
        {
          id: ids[9],
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
      reader: { agentId: "agent-9" },
      messages: [{ body: `/w/docs/artifacts/${id}` }],
    })
  )[0]!;
  expect(card).toMatchObject({ state: "open", canOpen: true });
});
