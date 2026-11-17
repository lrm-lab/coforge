import type { PrismaClient } from "#src/generated/prisma/client";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { peopleReadingArtifact, type ArtifactAccessRow } from "./artifact-access.server";
import { warnBestEffort } from "./artifact-best-effort.server";
import { inBatches } from "./artifact-notices.server";
import type { ArtifactSignals } from "./artifact-signals.server";

type WakeDb = Pick<
  PrismaClient,
  "artifactFollow" | "workspaceMembership" | "conversation" | "agent"
>;

export type AfterWrite = {
  workspaceId: string;
  artifact: ArtifactAccessRow & { id: string };
  writerUserId?: string | undefined;
  alsoUserIds?: readonly string[];
};

const WAKE_AT_ONCE = 50;

async function peopleToWake(db: WakeDb, write: AfterWrite) {
  const followers = await db.artifactFollow.findMany({
    where: { artifactId: write.artifact.id, following: true, userId: { not: null } },
    select: { userId: true },
  });
  const candidates = new Set([
    ...followers.flatMap(({ userId }) => userId ?? []),
    ...(write.alsoUserIds ?? []),
  ]);
  if (write.writerUserId) candidates.delete(write.writerUserId);
  return peopleReadingArtifact(db, write.workspaceId, write.artifact, [...candidates]);
}

async function wake(db: WakeDb, signals: ArtifactSignals, write: AfterWrite) {
  try {
    const people = [...(await peopleToWake(db, write))];
    await inBatches(people, WAKE_AT_ONCE, (userId) =>
      signals
        .publish(userConversationChannel(userId), {
          type: REALTIME_EVENTS.activityChanged,
          workspaceId: write.workspaceId,
        })
        .catch((error: unknown) => warnBestEffort("artifacts:activity_signal_failed", error)),
    );
  } catch (error) {
    warnBestEffort("artifacts:activity_wake_failed", error);
  }
}

export function settleWrite(
  db: WakeDb,
  signals: ArtifactSignals | undefined,
  write: AfterWrite | undefined,
) {
  if (!signals || !write) return;
  const work = () => wake(db, signals, write);
  if (signals.background) signals.background(work);
  else void work();
}
