import { findPersonalMemoryAssignment } from "#src/server/agents/agent-memory-composition.server";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import {
  decodeTeamMemoryResult,
  type TeamMemoryWrite,
  type TeamMemoryRelation,
} from "@lrm/coforge-sdk/agent";
import { handleTeamMemory } from "#src/server/team-memory/http.server";
import type { TeamMemoryActor } from "#src/server/team-memory/memory";

const url = Bun.env.TEAM_MEMORY_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "TEAM_MEMORY_TEST_DATABASE_URL must name a disposable migrated PostgreSQL database",
  );
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
let workspaceId: string, otherWorkspaceId: string, userId: string, agentId: string;
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: { username: `native-memory-${crypto.randomUUID()}`, displayName: "Memory owner" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `native-memory-${crypto.randomUUID()}`,
        name: "Team memory",
        experiments: { teamMemory: true },
        members: { create: { userId, role: "owner" } },
      },
    })
  ).id;
  otherWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: `native-memory-other-${crypto.randomUUID()}`,
        name: "Other",
        experiments: { teamMemory: true },
        members: { create: { userId } },
      },
    })
  ).id;
  const make = (name: string) =>
    db.agent.create({
      data: {
        workspaceId,
        ownerId: userId,
        name,
        displayName: name,
        runtimeConfig: { provider: "pi" },
      },
    });
  agentId = (await make("developer")).id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (otherWorkspaceId) await db.workspace.delete({ where: { id: otherWorkspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
const actor = () => ({ workspaceId, agentId });
const service = () => teamMemory(db);
const draft = (title: string, content: string) => ({
  title,
  content,
  source: "User-confirmed result",
  applicability: "staging",
  kind: "fact" as const,
});
async function reviewed<T extends TeamMemoryWrite>(command: T, who: TeamMemoryActor = actor()) {
  const review = await service().execute(who, command);
  expect(review.status).toBe("review_required");
  expect(review.reviewToken).toBeString();
  return { ...command, reviewToken: review.reviewToken! };
}
async function write(command: TeamMemoryWrite, who: TeamMemoryActor = actor()) {
  return service().execute(who, await reviewed(command, who));
}
async function create(title: string, content: string) {
  return (
    await write({ operation: "create", ...draft(title, content), requestId: crypto.randomUUID() })
  ).entries[0]!;
}

test("a current confirmation replaces only the named production revision", async () => {
  const old = (
    await write({
      operation: "create",
      ...draft("Rollout approval", "Migration awaiting approval"),
      applicability: "production",
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  const staging = await create("Rollout approval", "Migration completed in staging");
  const current = (
    await write({
      operation: "create",
      ...draft("Rollout approval", "Migration approved"),
      applicability: "production",
      requestId: crypto.randomUUID(),
      relations: [{ kind: "supersedes", id: old.id, revision: old.revision }],
    })
  ).entries[0]!;
  expect(current.relations).toEqual([{ kind: "supersedes", id: old.id, revision: old.revision }]);
  const found = await service().execute(actor(), {
    operation: "search",
    query: "Rollout approval",
  });
  const ids = found.entries.map(({ id }) => id);
  expect(ids).toContain(current.id);
  expect(ids).toContain(staging.id);
  expect(ids).not.toContain(old.id);
  const history = await service().execute(actor(), {
    operation: "get",
    id: old.id,
    revision: old.revision,
  });
  expect(history.entries[0]?.content).toBe(old.content);
  await write({
    operation: "archive",
    id: current.id,
    revision: current.revision,
    reason: "Withdrawal",
    requestId: crypto.randomUUID(),
  });
  expect(
    (
      await service().execute(actor(), { operation: "search", query: "Rollout approval" })
    ).entries.map(({ id }) => id),
  ).toContain(old.id);
});

test("structured evidence is accepted and returned only while Workspace-readable", async () => {
  const artifact = await db.artifact.create({
    data: {
      workspaceId,
      homeKey: "workspace",
      access: "workspace",
      name: "reviewed-evidence",
      entryPath: "index.md",
    },
  });
  const evidence = [{ kind: "artifact" as const, id: artifact.id }];
  const created = (
    await write({
      operation: "create",
      ...draft("Review evidence", "Verified by a published document"),
      requestId: crypto.randomUUID(),
      evidence,
    })
  ).entries[0]!;
  expect(created.evidence).toEqual(evidence);
  await db.artifact.update({
    where: { id: artifact.id },
    data: { access: "conversation", homeKey: `conversation:${crypto.randomUUID()}` },
  });
  const historical = await service().execute(actor(), {
    operation: "get",
    id: created.id,
    revision: 1,
  });
  expect(historical.entries[0]?.evidence).toEqual([]);
  const invalid = await reviewed({
    operation: "create",
    ...draft("New restricted evidence", "Not Workspace-readable"),
    requestId: crypto.randomUUID(),
    evidence,
  });
  await expect(service().execute(actor(), invalid)).rejects.toThrow("memory_forbidden");
});

test("task recall expands incoming conflicts and excludes different Projects", async () => {
  const project = await db.project.create({
    data: { workspaceId, name: "Recall scope", slug: "recall-scope" },
  });
  const other = await db.project.create({
    data: { workspaceId, name: "Other project", slug: "other-recall-scope" },
  });
  const createScoped = async (
    title: string,
    content: string,
    projectId: string,
    relations?: TeamMemoryRelation[],
  ) =>
    (
      await write({
        operation: "create",
        ...draft(title, content),
        projectId,
        requestId: crypto.randomUUID(),
        relations,
      })
    ).entries[0]!;
  const result = await createScoped("Quasar fingerprint", "Approved after testing", project.id);
  const disagreement = await createScoped(
    "Independent objection",
    "Approval still pending",
    project.id,
    [{ kind: "conflicts_with", id: result.id, revision: result.revision }],
  );
  const foreign = await createScoped("Quasar fingerprint", "Other project", other.id);
  const found = await service().execute(actor(), {
    operation: "search",
    projectId: project.id,
    includeWorkspace: true,
    includeConflicts: true,
    query: "Quasar fingerprint",
  });
  expect(found.entries.map(({ id }) => id)).toEqual([result.id, disagreement.id]);
  expect(found.entries[0]?.relations).toContainEqual({
    kind: "conflicts_with",
    id: disagreement.id,
    revision: disagreement.revision,
  });
  expect(found.entries.map(({ id }) => id)).not.toContain(foreign.id);
});

test("members create and correct team memories with real human attribution", async () => {
  const member = await db.user.create({
    data: { username: `memory-member-${crypto.randomUUID()}`, displayName: "Memory member" },
  });
  try {
    await db.workspaceMembership.create({ data: { workspaceId, userId: member.id } });
    const human = { workspaceId, userId: member.id };
    const created = (
      await write(
        {
          operation: "create",
          ...draft("Human confirmed", "A shared fact"),
          requestId: crypto.randomUUID(),
        },
        human,
      )
    ).entries[0]!;
    expect(created.authorUserId).toBe(member.id);
    expect(created.authorAgentId).toBeNull();
    expect(decodeTeamMemoryResult({ status: "ok", entries: [created] }).entries[0]?.id).toBe(
      created.id,
    );
    const existing = await create("Agent confirmed", "Original conclusion");
    const edited = (
      await write(
        {
          operation: "update",
          id: existing.id,
          revision: existing.revision,
          ...draft(existing.title, "Corrected by a member"),
          reason: "Verified correction",
          requestId: crypto.randomUUID(),
        },
        human,
      )
    ).entries[0]!;
    expect(edited.content).toBe("Corrected by a member");
    const history = await service().execute(human, { operation: "history", id: edited.id });
    expect(history.entries[0]?.change?.actorUserId).toBe(member.id);
    expect(history.entries[1]?.content).toBe("Original conclusion");
    await expect(
      write(
        {
          operation: "delete",
          id: edited.id,
          revision: edited.revision,
          reason: "Not mine",
          requestId: crypto.randomUUID(),
        },
        human,
      ),
    ).rejects.toThrow("memory_forbidden");
    await db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId, userId: member.id } },
    });
    await expect(service().execute(human, { operation: "list" })).rejects.toThrow(
      "memory_forbidden",
    );
  } finally {
    await db.workspaceMembership.deleteMany({ where: { workspaceId, userId: member.id } });
    await db.user.delete({ where: { id: member.id } });
  }
});

test("optional projects are scoped to the workspace and deleting a project retains memory", async () => {
  const project = await db.project.create({
    data: { workspaceId, name: "Memory project", slug: `memory-${crypto.randomUUID()}` },
  });
  const other = await db.project.create({
    data: {
      workspaceId: otherWorkspaceId,
      name: "Other project",
      slug: `memory-${crypto.randomUUID()}`,
    },
  });
  const entry = (
    await write({
      operation: "create",
      ...draft("Project decision", "The agreed project constraint"),
      projectId: project.id,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  expect(entry.projectId).toBe(project.id);
  expect(
    (await service().execute(actor(), { operation: "list", projectId: project.id })).entries.map(
      (x) => x.id,
    ),
  ).toContain(entry.id);
  await expect(
    write({
      operation: "update",
      id: entry.id,
      revision: entry.revision,
      ...draft(entry.title, entry.content),
      projectId: other.id,
      reason: "Wrong project",
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_forbidden");
  const corrected = (
    await write({
      operation: "update",
      id: entry.id,
      revision: entry.revision,
      ...draft(entry.title, "A correction from an old client"),
      reason: "Keep the project",
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  expect(corrected.projectId).toBe(project.id);
  await db.project.delete({ where: { id: project.id } });
  expect(
    (await service().execute(actor(), { operation: "get", id: entry.id })).entries[0]?.projectId,
  ).toBeNull();
  const duplicate = await create(entry.title, "A correction from an old client");
  expect(duplicate.id).toBe(entry.id);
});

test("project discovery is paginated and creation reuses an exact existing project", async () => {
  const command = {
    operation: "project-create" as const,
    name: "Research",
    slug: `memory-research-${crypto.randomUUID()}`,
    description: "Confirmed project",
  };
  const first = await service().execute(actor(), command);
  const second = await service().execute({ workspaceId, userId }, command);
  expect(first.projects?.[0]?.id).toBe(second.projects?.[0]?.id);
  await expect(
    service().execute(actor(), { ...command, name: "Different project" }),
  ).rejects.toThrow("memory_conflict");
  await db.project.createMany({
    data: Array.from({ length: 24 }, (_, index) => ({
      workspaceId,
      name: `Discovery ${index}`,
      slug: `discovery-${index}-${crypto.randomUUID()}`,
    })),
  });
  const page = await service().execute(actor(), { operation: "projects", query: "Discovery" });
  expect(page.projects).toHaveLength(20);
  expect(page.nextOffset).toBe(20);
  expect(
    (
      await service().execute(actor(), {
        operation: "projects",
        query: "Discovery",
        offset: page.nextOffset,
      })
    ).projects,
  ).toHaveLength(4);
});

test("a duplicate create keeps the original evidence, protection and revision", async () => {
  const fields = draft("Protected deployment fact", "Retain this decision");
  const original = (
    await write({
      operation: "create",
      ...fields,
      pinned: true,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  const human = { workspaceId, userId };
  const duplicate = await reviewed(
    {
      operation: "create",
      ...fields,
      source: "Different evidence",
      projectId: null,
      pinned: false,
      requestId: crypto.randomUUID(),
    },
    human,
  );
  expect((await service().execute(human, duplicate)).entries).toEqual([original]);
  expect((await service().execute(human, duplicate)).replayed).toBe(true);
  expect(
    (await service().execute(human, { operation: "history", id: original.id })).entries,
  ).toHaveLength(1);
});

test("shared memory list and search previews retain content after leading indentation", async () => {
  const padded = (
    await write({
      operation: "create",
      ...draft("Indented guidance", `${" ".repeat(600)}Verified paragraph`),
      source: `${" ".repeat(200)}Verified source`,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  for (const query of [
    { operation: "list" },
    { operation: "search", query: "Indented guidance" },
  ] as const) {
    const page = decodeTeamMemoryResult(await service().execute(actor(), query));
    expect(page.entries.find((entry) => entry.id === padded.id)).toMatchObject({
      content: "Verified paragraph",
      source: "Verified source",
    });
  }
});

test("correcting an archived entry keeps it archived until an explicit restore", async () => {
  const entry = await create("Archived deployment fact", "Initial archived value");
  const human = { workspaceId, userId };
  const archived = (
    await write(
      {
        operation: "archive",
        id: entry.id,
        revision: entry.revision,
        reason: "Retire old guidance",
        requestId: crypto.randomUUID(),
      },
      human,
    )
  ).entries[0]!;
  const corrected = (
    await write(
      {
        operation: "update",
        id: archived.id,
        revision: archived.revision,
        ...draft(entry.title, "Corrected archived value"),
        reason: "Fix the record",
        requestId: crypto.randomUUID(),
      },
      human,
    )
  ).entries[0]!;
  expect(corrected.status).toBe("archived");
  expect(
    (await service().execute(actor(), { operation: "search", query: "archived" })).entries.some(
      (item) => item.id === entry.id,
    ),
  ).toBe(false);
  const restored = (
    await write(
      {
        operation: "restore",
        id: corrected.id,
        revision: corrected.revision,
        fromRevision: corrected.revision,
        reason: "Reactivate the record",
        requestId: crypto.randomUUID(),
      },
      human,
    )
  ).entries[0]!;
  expect(restored).toMatchObject({ status: "active", content: "Corrected archived value" });
});

test("legacy Computers keep reading Agent knowledge while upgraded Computers also see human entries", async () => {
  const entry = (
    await write(
      {
        operation: "create",
        ...draft("Human rollout", "Confirmed by a person"),
        requestId: crypto.randomUUID(),
      },
      { workspaceId, userId },
    )
  ).entries[0]!;
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example.com/api/agent/v1/team-memory", {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "search", query: "Human rollout" }),
    });
  const legacy = await handleTeamMemory(request(), actor(), service());
  expect(legacy.status).toBe(200);
  expect(
    decodeTeamMemoryResult(await legacy.json()).entries.some((item) => item.id === entry.id),
  ).toBe(false);
  const modern = await handleTeamMemory(
    request({ "x-coforge-memory-authors": "2" }),
    actor(),
    service(),
  );
  expect(
    decodeTeamMemoryResult(await modern.json()).entries.some((item) => item.id === entry.id),
  ).toBe(true);
  const direct = await handleTeamMemory(
    new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ operation: "get", id: entry.id }),
    }),
    actor(),
    service(),
  );
  expect(direct.status).toBe(426);
  const known = await create("Legacy rollout", "The original Agent knowledge");
  const oldRead = await handleTeamMemory(
    new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ operation: "get", id: known.id }),
    }),
    actor(),
    service(),
  );
  expect(decodeTeamMemoryResult(await oldRead.json()).entries[0]?.id).toBe(known.id);
});

test("personal memory assignment is owner-only even for a Workspace administrator", async () => {
  const admin = await db.user.create({
    data: { username: `memory-admin-${crypto.randomUUID()}`, displayName: "Administrator" },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: userId,
      machineId: `memory-${crypto.randomUUID()}`,
      name: "Personal memory Computer",
      workspaces: { create: { workspaceId } },
    },
  });
  try {
    await db.workspaceMembership.create({ data: { workspaceId, userId: admin.id, role: "admin" } });
    await db.agent.update({ where: { id: agentId }, data: { computerId: computer.id } });
    expect(
      (await findPersonalMemoryAssignment(db, { workspaceId, userId }, agentId))?.computerId,
    ).toBe(computer.id);
    expect(
      await findPersonalMemoryAssignment(db, { workspaceId, userId: admin.id }, agentId),
    ).toBeUndefined();
    await db.workspaceMembership.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
    expect(
      await findPersonalMemoryAssignment(db, { workspaceId, userId }, agentId),
    ).toBeUndefined();
  } finally {
    await db.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, role: "owner" },
      update: { role: "owner" },
    });
    await db.agent.update({ where: { id: agentId }, data: { computerId: null } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.workspaceMembership.deleteMany({ where: { workspaceId, userId: admin.id } });
    await db.user.delete({ where: { id: admin.id } });
  }
});
