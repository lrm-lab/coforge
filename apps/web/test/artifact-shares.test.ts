import { expect, test } from "bun:test";
import { ArtifactShares } from "#src/server/artifacts/artifact-shares.server";

const ARTIFACT = "00000000-0000-4000-8000-000000000001";

test("artifact share posts one live-link message per target with derived keys, the same body to each", async () => {
  const sent: { target: string; idempotencyKey: string; body: string }[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findFirst: async () => ({ id: ARTIFACT, title: "Launch plan", homeKey: "workspace" }),
    },
    workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
    agent: { findFirst: async () => ({ id: "agent-owner" }) },
    conversation: { findFirst: async () => null },
  };
  const shares = new ArtifactShares(db as never, async () => true);
  const result = await shares.share({
    workspaceId: "workspace-1",
    actor: { userId: "user-1" },
    artifactId: ARTIFACT,
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
  expect(sent[1]!.body).toBe(sent[0]!.body);
  expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
});

test("artifact share refuses a non-member's artifact before sending", async () => {
  let sends = 0;
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findFirst: async () => ({ id: ARTIFACT, title: "Private", homeKey: "workspace" }),
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
      artifactId: ARTIFACT,
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

test("a home the Workspace hides is not shared", async () => {
  const home = "00000000-0000-4000-8000-000000000009";
  const sent: string[] = [];
  const db = {
    workspace: { findUnique: async () => ({ slug: "docs" }) },
    artifact: {
      findFirst: async () => ({
        id: ARTIFACT,
        title: "Hidden home",
        homeKey: `conversation:${home}`,
      }),
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
      artifactId: ARTIFACT,
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

test("artifact sharing rejects more than twenty targets", async () => {
  const shares = new ArtifactShares({} as never, async () => true);
  const send = async () => ({ id: "message", sequence: 1 });
  const base = {
    workspaceId: "workspace-1",
    actor: { userId: "user-1" } as const,
    requestId: "00000000-0000-4000-8000-000000000005",
    send,
  };
  await expect(
    shares.share({
      ...base,
      artifactId: ARTIFACT,
      targets: Array.from({ length: 21 }, (_, index) => `#launch-${index}`),
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
