import type { PrismaClient } from "#src/generated/prisma/client";
import { agentsReadingArtifact } from "./artifact-access.server";

const artifactIdOf = (externalEventId: string) =>
  externalEventId.slice(0, Math.max(0, externalEventId.indexOf(":")));

export async function artifactNoticeBlockedMessages(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  messageIds: readonly string[],
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const events = await db.systemAgentEvent.findMany({
    where: {
      workspaceId,
      agentId,
      source: "system.artifacts",
      messageId: { in: [...messageIds] },
    },
    select: { messageId: true, externalEventId: true },
  });
  if (events.length === 0) {
    console.log("DIAG events=0", messageIds.length);
    return new Set();
  }
  const artifacts = await db.artifact.findMany({
    where: {
      workspaceId,
      id: { in: [...new Set(events.map((event) => artifactIdOf(event.externalEventId)))] },
    },
    select: { id: true, homeKey: true, access: true, authorAgentId: true, deletedAt: true },
  });
  const readable = new Set<string>();
  for (const artifact of artifacts)
    if (
      !artifact.deletedAt &&
      (await agentsReadingArtifact(db, workspaceId, artifact, [agentId])).has(agentId)
    )
      readable.add(artifact.id);
  console.log(
    "DIAG",
    JSON.stringify({ events: events.length, artifacts: artifacts.length, readable: [...readable] }),
  );
  return new Set(
    events
      .filter((event) => !readable.has(artifactIdOf(event.externalEventId)))
      .map((event) => event.messageId),
  );
}
