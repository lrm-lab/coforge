import { expect, test } from "bun:test";
import { ArtifactReads } from "#src/server/artifacts/artifact-reads.server";

const ids = Array.from(
  { length: 20 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

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
          authorAgentId: null,
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
