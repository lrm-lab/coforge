import { expect, test } from "bun:test";
import { ArtifactShares } from "#src/server/artifacts/artifact-shares.server";

const ARTIFACT = "00000000-0000-4000-8000-000000000001";

test("artifact share posts one live-link message per target with derived keys", async () => {
  const sent: { target: string; idempotencyKey: string; body: string }[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findMany: async () => [{ id: ARTIFACT, title: "Launch plan", homeKey: "workspace" }],
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

test("artifact share refuses a non-member's artifact before sending", async () => {
  let sends = 0;
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findMany: async () => [{ id: ARTIFACT, title: "Private", homeKey: "workspace" }],
    },
    // Every member reads every artifact (task #20); a non-member hears NOT_FOUND.
    workspaceMembership: { findUnique: async () => null },
    agent: { findFirst: async () => null },
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

test("an Agent target outside the Workspace gets the neutral plural share text", async () => {
  const second = "00000000-0000-4000-8000-000000000003";
  const sent: string[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findMany: async () => [
        { id: ARTIFACT, title: "Readable", homeKey: "workspace" },
        { id: second, title: "Private", homeKey: "workspace" },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    // The sharing Agent is a member; the target Agent is not, so it may not read the links.
    agent: {
      findFirst: async (args: { where: { id: string } }) =>
        args.where.id === "agent-owner" ? { id: "agent-owner" } : null,
    },
    conversation: { findFirst: async () => null },
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

test("a member Agent target's titles pair with their own links, not the row order", async () => {
  const second = "00000000-0000-4000-8000-000000000003";
  const sent: string[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      // `findMany` answers unordered; here it is the reverse of `artifactIds`.
      findMany: async () => [
        { id: second, title: "Second", homeKey: "workspace" },
        { id: ARTIFACT, title: "First", homeKey: "workspace" },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    agent: { findFirst: async () => ({ id: "agent" }) },
    conversation: { findFirst: async () => null },
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
    `First\n/w/docs/artifacts/${ARTIFACT}\n\nSecond\n/w/docs/artifacts/${second}`,
  ]);
});

test("a home the Workspace hides is not shared", async () => {
  const home = "00000000-0000-4000-8000-000000000009";
  const sent: string[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findMany: async () => [
        { id: ARTIFACT, title: "Hidden home", homeKey: `conversation:${home}` },
      ],
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    agent: { findFirst: async () => null },
    // `hiddenFromWorkspaceConversationIds` asks only for the hidden ones; this one is.
    conversation: { findMany: async () => [{ id: home }] },
  };
  const shares = new ArtifactShares(db as never, async () => true);
  await expect(
    shares.share({
      workspaceId: "workspace-1",
      actor: { userId: "user-1" },
      artifactIds: [ARTIFACT],
      targets: ["#launch"],
      requestId: "00000000-0000-4000-8000-000000000002",
      send: async ({ body }) => {
        sent.push(body);
        return { id: "message", sequence: 1 };
      },
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(sent).toHaveLength(0);
});

test("artifact sharing rejects more than twenty artifacts or targets", async () => {
  const shares = new ArtifactShares({} as never, async () => true);
  const send = async () => ({ id: "message", sequence: 1 });
  const base = {
    workspaceId: "workspace-1",
    actor: { agentId: "agent-1" } as const,
    requestId: "00000000-0000-4000-8000-000000000005",
    send,
  };
  await expect(
    shares.share({
      ...base,
      artifactIds: Array.from({ length: 21 }, () => ARTIFACT),
      targets: ["#launch"],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    shares.share({
      ...base,
      artifactIds: [ARTIFACT],
      targets: Array.from({ length: 21 }, (_, index) => `#launch-${index}`),
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
