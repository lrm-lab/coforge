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

export type ArtifactCheckJobRunner = (
  job: ArtifactVersionCheckJob,
  options: { retryable: boolean },
) => Promise<void>;

let activeBossAccessor: (() => Pick<PgBoss, "send"> | undefined) | null = null;
let activeJobRunner: ArtifactCheckJobRunner | null = null;

export function registerArtifactCheckQueueAccessor(
  accessor: () => Pick<PgBoss, "send"> | undefined,
): void {
  activeBossAccessor = accessor;
}

export function registerArtifactCheckJobRunner(runner: ArtifactCheckJobRunner): void {
  activeJobRunner = runner;
}

export async function runRegisteredArtifactCheckJob(
  job: ArtifactVersionCheckJob,
  options: { retryable: boolean },
): Promise<void> {
  if (!activeJobRunner) {
    throw new Error("Artifact publish check job runner is not registered");
  }
  await activeJobRunner(job, options);
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
