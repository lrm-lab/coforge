import type { PrismaClient } from "#src/generated/prisma/client";

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
      entryPath: input.entryPath,
      authorAgentId: input.author.agentId,
    },
  });
}
