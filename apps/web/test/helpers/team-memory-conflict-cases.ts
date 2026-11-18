import { expect } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import type { TeamMemoryRelation, TeamMemoryWrite, TeamMemoryResult } from "@lrm/coforge-sdk/agent";
import type { TeamMemoryActor } from "#src/server/team-memory/memory";

export async function verifyTaskRecallConflicts(
  db: PrismaClient,
  actor: TeamMemoryActor,
  draft: (
    title: string,
    content: string,
  ) => Pick<
    TeamMemoryWrite & { operation: "create" },
    "title" | "content" | "source" | "applicability" | "kind"
  >,
  write: (command: TeamMemoryWrite) => Promise<TeamMemoryResult>,
) {
  const { workspaceId } = actor;
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
  const found = await teamMemory(db).execute(actor, {
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

  await createScoped("Updated objection", "Approval now confirmed", project.id, [
    { kind: "supersedes", id: disagreement.id, revision: disagreement.revision },
  ]);
  const command = {
    operation: "search" as const,
    projectId: project.id,
    includeWorkspace: true,
    includeConflicts: true,
    query: "Quasar fingerprint",
  };
  const current = await teamMemory(db).execute(actor, command);
  expect(current.entries.map(({ id }) => id)).toEqual([result.id]);
  const historical = await teamMemory(db).execute(actor, { ...command, includeSuperseded: true });
  expect(historical.entries.map(({ id }) => id)).toContain(disagreement.id);

  const matches = [];
  for (let index = 0; index < 6; index++) {
    matches.push(
      await createScoped(
        `Quasar fingerprint ${index}`,
        `Independent evidence ${index}`,
        project.id,
      ),
    );
  }
  const peer = await createScoped("Current objection", "Review remained open", project.id, [
    { kind: "conflicts_with", id: matches[5]!.id, revision: matches[5]!.revision },
  ]);
  const first = await teamMemory(db).execute(actor, command);
  expect(first.nextOffset).toBe(5);
  const second = await teamMemory(db).execute(actor, { ...command, offset: first.nextOffset });
  expect(second.nextOffset).toBeUndefined();
  expect(new Set([...first.entries, ...second.entries].map(({ id }) => id))).toEqual(
    new Set([result.id, peer.id, ...matches.map(({ id }) => id)]),
  );
}
