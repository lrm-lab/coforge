import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";

export function legacyWorkspaceArtifact(
  db: PrismaClient,
  input: {
    workspaceId: string;
    name: string;
    entryPath: string;
    author: { agentId: string };
    title?: string;
    description?: string;
  },
) {
  return db.artifact.create({
    data: {
      workspaceId: input.workspaceId,
      homeKey: "workspace",
      name: input.name,
      title: input.title ?? "",
      description: input.description ?? "",
      kind: artifactKindOfPath(input.entryPath),
      entryPath: input.entryPath,
      authorAgentId: input.author.agentId,
    },
  });
}
