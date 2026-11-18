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
}
