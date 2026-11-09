import { expect, test } from "bun:test";
import { ArtifactShares } from "#src/server/artifacts/artifact-shares.server";

const ARTIFACT = "00000000-0000-4000-8000-000000000001";

test("artifact share posts one live-link message per target with derived keys", async () => {
  const sent: { target: string; idempotencyKey: string; body: string }[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findMany: async () => [
        { id: ARTIFACT, title: "Launch plan", homeKey: "workspace", access: "workspace" },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    agent: { findFirst: async () => ({ id: "agent-owner" }) },
    conversation: { findFirst: async () => null },
  };
  const shares = new ArtifactShares(
    db as never,
    async () => true,
    async (_workspace, _agent, target) =>
      target.startsWith("@") ? { kind: "agent", agentId: "agent-target" } : { kind: "other" },
  );
  const result = await shares.share({
    workspaceId: "workspace-1",
    actor: { agentId: "agent-owner" },
    artifactIds: [ARTIFACT],
    targets: ["#launch", "@ada"],
    note: "Please review",
    requestId: "00000000-0000-4000-8000-000000000002",
    send: async (input) => {
      sent.push(input);
      return { id: `message-${sent.length}`, sequence: sent.length };
    },
  });

  expect(result.outcome).toBe("success");
  expect(result.results).toHaveLength(2);
  expect(sent[0]!.body).toBe(`Please review\n\n/w/docs/artifacts/${ARTIFACT}`);
  expect(sent[1]!.body).toBe(`Please review\n\nLaunch plan\n/w/docs/artifacts/${ARTIFACT}`);
  expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
});

test("artifact share refuses an unreadable artifact before sending", async () => {
  let sends = 0;
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findMany: async () => [
        { id: ARTIFACT, title: "Private", homeKey: "conversation:secret", access: "conversation" },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    agent: { findFirst: async () => null },
    conversation: {
      findFirst: async () => ({
        channelName: "secret",
        visibility: "private",
        archivedAt: null,
        members: [],
      }),
    },
  };
  const shares = new ArtifactShares(db as never, async () => true);
  await expect(
    shares.share({
      workspaceId: "workspace-1",
      actor: { userId: "user-1" },
      artifactIds: [ARTIFACT],
      targets: ["#launch"],
      requestId: "00000000-0000-4000-8000-000000000002",
      send: async () => {
        sends += 1;
        return { id: "message", sequence: 1 };
      },
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(sends).toBe(0);
});

test("an Agent target with mixed artifact access uses the neutral plural share text", async () => {
  const second = "00000000-0000-4000-8000-000000000003";
  const sent: string[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findMany: async () => [
        { id: ARTIFACT, title: "Readable", homeKey: "workspace", access: "workspace" },
        {
          id: second,
          title: "Private",
          homeKey: "conversation:00000000-0000-4000-8000-000000000010",
          access: "conversation",
        },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    agent: { findFirst: async () => ({ id: "agent-owner" }) },
    conversation: {
      findFirst: async (input: { select?: { members?: { where?: { agentId?: string } } } }) => ({
        channelName: "secret",
        visibility: "private",
        archivedAt: null,
        members: input.select?.members?.where?.agentId === "agent-target" ? [] : [{ id: "member" }],
      }),
    },
  };
  const shares = new ArtifactShares(
    db as never,
    async () => true,
    async () => ({ kind: "agent", agentId: "agent-target" }),
  );
  await shares.share({
    workspaceId: "workspace-1",
    actor: { agentId: "agent-owner" },
    artifactIds: [ARTIFACT, second],
    targets: ["@ada"],
    requestId: "00000000-0000-4000-8000-000000000004",
    send: async ({ body }) => {
      sent.push(body);
      return { id: "message", sequence: 1 };
    },
  });
  expect(sent).toEqual([
    `One artifact was shared:\n/w/docs/artifacts/${ARTIFACT}\n/w/docs/artifacts/${second}`,
  ]);
});
