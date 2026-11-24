import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { TeamMemoryDraft } from "@lrm/coforge-sdk/agent";
import { PrismaClient } from "#src/generated/prisma/client";
import { readTeamMemoryDecisionGraph } from "#src/server/db/repositories/team-memory-decision-graph.server";
import { teamMemory } from "#src/server/team-memory/composition.server";

const url = Bun.env.TEAM_MEMORY_TEST_DATABASE_URL;
if (!url) throw new Error("TEAM_MEMORY_TEST_DATABASE_URL must name an isolated migrated database");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const memory = teamMemory(db);
const principal = { workspaceId: "", userId: "" };
let outsiderId = "";

beforeAll(async () => {
  const stamp = crypto.randomUUID();
  const [owner, outsider] = await Promise.all([
    db.user.create({ data: { username: `graph-owner-${stamp}`, displayName: "Owner" } }),
    db.user.create({ data: { username: `graph-outsider-${stamp}`, displayName: "Outsider" } }),
  ]);
  principal.userId = owner.id;
  outsiderId = outsider.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Decision graph",
      slug: `decision-graph-${stamp}`,
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  principal.workspaceId = workspace.id;
});

afterAll(async () => {
  if (principal.workspaceId) await db.workspace.delete({ where: { id: principal.workspaceId } });
  await db.user.deleteMany({
    where: { id: { in: [principal.userId, outsiderId].filter(Boolean) } },
  });
  await db.$disconnect();
});

async function save(title: string, fields: Partial<TeamMemoryDraft> = {}) {
  const create = {
    operation: "create" as const,
    kind: "decision" as const,
    title,
    content: title,
    source: "Public work",
    applicability: "staging",
    requestId: crypto.randomUUID(),
    ...fields,
  };
  const review = await memory.execute(principal, create);
  return (await memory.execute(principal, { ...create, reviewToken: review.reviewToken! }))
    .entries[0]!;
}

test("a historical graph finds reverse replacements and keeps references at exact versions", async () => {
  const old = await save("Use shared certificates");
  const other = await save("Keep the old entry point");
  const replacement = await save("Issue separate certificates", {
    relations: [
      { kind: "supersedes", id: old.id, revision: old.revision },
      { kind: "conflicts_with", id: other.id, revision: other.revision },
    ],
  });
  const graph = await readTeamMemoryDecisionGraph(db, principal, { id: old.id, revision: 1 });
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: old.id, revision: 1, current: false }),
      expect.objectContaining({ id: replacement.id, revision: 1, current: true }),
    ]),
  );
  expect(graph.edges).toContainEqual({
    from: `memory:${old.id}:1`,
    to: `memory:${replacement.id}:1`,
    kind: "supersedes",
  });
  const current = await readTeamMemoryDecisionGraph(db, principal, { id: replacement.id });
  expect(current.edges).toContainEqual({
    from: `memory:${replacement.id}:1`,
    to: `memory:${other.id}:1`,
    kind: "conflicts_with",
  });
});

test("withdrawing task evidence immediately removes its entries from recall, including pinned entries", async () => {
  const { workspaceId, userId } = principal;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: "graph-evidence",
      visibility: "public",
      members: { create: { userId } },
    },
    include: { members: true },
  });
  const task = await db.task.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      number: 128,
      title: "Verify certificate rollout",
      creatorMemberId: channel.members[0]!.id,
      status: "done",
    },
  });
  const evidence = [{ kind: "task" as const, id: task.id, revision: task.revision }];
  const record = await save("Use verified TLS rollout", { evidence });
  const pinned = await save("Reserve the TLS rollout window", { evidence, pinned: true });
  const standalone = await save("Log TLS rollout latency");
  const objection = await save("Keep the older approval policy outside this case", {
    evidence,
    relations: [{ kind: "conflicts_with", id: standalone.id, revision: standalone.revision }],
  });
  const search = { operation: "search" as const, query: "TLS rollout" };
  const ids = async (includeConflicts: boolean) =>
    (await memory.execute(principal, { ...search, includeConflicts })).entries.map(({ id }) => id);
  expect(await ids(false)).toEqual(expect.arrayContaining([record.id, pinned.id, standalone.id]));
  expect(await ids(true)).toEqual(
    expect.arrayContaining([record.id, pinned.id, standalone.id, objection.id]),
  );
  const graph = await readTeamMemoryDecisionGraph(db, principal, { id: record.id });
  expect(graph.nodes).toContainEqual(
    expect.objectContaining({
      id: task.id,
      revision: task.revision,
      key: `task:${task.id}:${task.revision}`,
      title: task.title,
      conversationId: channel.id,
      taskNumber: 128,
    }),
  );
  expect(graph.edges).toContainEqual({
    from: `task:${task.id}:${task.revision}`,
    to: graph.root,
    kind: "supports",
  });
  await db.conversation.update({
    where: { id: channel.id },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  const hidden = await readTeamMemoryDecisionGraph(db, principal, { id: record.id });
  expect(hidden.nodes).toHaveLength(1);
  expect(hidden.edges).toEqual([]);
  expect(await ids(false)).toEqual([standalone.id]);
  const recalled = await memory.execute(principal, { ...search, includeConflicts: true });
  expect(recalled.entries.map(({ id }) => id)).toEqual([standalone.id]);
  expect(recalled.entries[0]?.relations).toContainEqual({
    kind: "conflicts_with",
    id: objection.id,
    revision: objection.revision,
  });
  const history = await memory.execute(principal, {
    operation: "get",
    id: pinned.id,
    revision: pinned.revision,
  });
  expect(history.entries[0]).toMatchObject({ id: pinned.id, pinned: true, evidence: [] });
});

test("a graph omits withdrawn evidence and cannot be opened without Workspace membership", async () => {
  const record = await save("Share deployment estimates");
  const unauthorizedId = crypto.randomUUID();
  await db.teamMemoryEntry.update({
    where: { id: record.id },
    data: { evidence: [{ kind: "message", id: unauthorizedId }] },
  });
  const graph = await readTeamMemoryDecisionGraph(db, principal, { id: record.id });
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes.every((node) => node.id !== unauthorizedId)).toBe(true);
  await expect(
    readTeamMemoryDecisionGraph(db, { ...principal, userId: outsiderId }, { id: record.id }),
  ).rejects.toThrow("memory_forbidden");
});

test("an earlier replacement remains visible after its current entry changes the relationship", async () => {
  const old = await save("Use provider supplied callbacks");
  const replacement = await save("Add callback retry", {
    relations: [{ kind: "supersedes", id: old.id, revision: old.revision }],
  });
  const update = {
    operation: "update" as const,
    id: replacement.id,
    revision: replacement.revision,
    title: replacement.title,
    content: "Retry remains a separate option",
    source: replacement.source,
    kind: replacement.kind,
    applicability: replacement.applicability,
    reason: "Both options are now available",
    requestId: crypto.randomUUID(),
    relations: [],
  };
  const review = await memory.execute(principal, update);
  await memory.execute(principal, { ...update, reviewToken: review.reviewToken! });
  const graph = await readTeamMemoryDecisionGraph(db, principal, { id: old.id });
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: old.id, revision: 1, current: true }),
      expect.objectContaining({ id: replacement.id, revision: 1, current: false }),
    ]),
  );
  expect(graph.edges).toContainEqual({
    from: graph.root,
    to: `memory:${replacement.id}:1`,
    kind: "supersedes",
  });
});

test("a scheduled replacement is visible with its status while the existing decision is current", async () => {
  const old = await save("Publish the existing service");
  const next = await save("Enable the new service on launch day", {
    effectiveAt: "2999-01-01T00:00:00.000Z",
    relations: [{ kind: "supersedes", id: old.id, revision: old.revision }],
  });
  const graph = await readTeamMemoryDecisionGraph(db, principal, { id: old.id });
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: old.id, current: true, scheduled: false }),
      expect.objectContaining({ id: next.id, current: false, scheduled: true }),
    ]),
  );
});
