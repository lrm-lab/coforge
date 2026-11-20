import type { PgBoss, Queue, SendOptions } from "pg-boss";

export const ARTIFACT_VERSION_CHECK_QUEUE = "artifact-version-check";

export type ArtifactVersionCheckJob = {
  checkId: string;
  workspaceId: string;
  artifactId: string;
  version: number;
};

export const ARTIFACT_VERSION_CHECK_QUEUE_OPTIONS: Partial<Queue> & { retryLimit: number } = {
  policy: "short",
  retryLimit: 2,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 180,
};

let activeBossAccessor: (() => Pick<PgBoss, "send"> | undefined) | null = null;

export function registerArtifactCheckQueueAccessor(
  accessor: () => Pick<PgBoss, "send"> | undefined,
): void {
  activeBossAccessor = accessor;
}

export async function enqueueArtifactVersionCheck(
  boss: Pick<PgBoss, "send">,
  job: ArtifactVersionCheckJob,
): Promise<string | null> {
  const options: SendOptions = {
    singletonKey: `${job.artifactId}:${job.version}`,
  };
  return boss.send(ARTIFACT_VERSION_CHECK_QUEUE, job, options);
}

export async function enqueueArtifactVersionCheckFromActiveQueue(
  job: ArtifactVersionCheckJob,
): Promise<string | null> {
  const boss = activeBossAccessor?.();
  if (!boss) return null;
  return enqueueArtifactVersionCheck(boss, job);
}
