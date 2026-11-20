import {
  ARTIFACT_CHECK_RETENTION_VERSIONS,
  ARTIFACT_CHECK_SHOT_MAX_BYTES,
  ARTIFACT_CHECK_VIEWPORTS,
  type ArtifactCheckResponse,
  type ArtifactCheckShot,
  type ArtifactCheckShotResponse,
} from "@lrm/coforge-sdk/agent";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { AppError } from "#src/lib/app-error";
import { errorType } from "#src/server/errors/error-type.server";
import type { ArtifactActor } from "./artifact-access.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import {
  defaultArtifactCheckLogger,
  summarizeFindings,
  summarizeShots,
  type ArtifactCheckLogger,
} from "./artifact-check-log.server";
import type { ArtifactVersionCheckJob } from "./artifact-check-queue.server";
import {
  ALLOWED_CDN_HOSTS,
  buildCheckBundle,
  parseStoredScreenshots,
  sanitizeFindings,
  toCheckRecord,
  type StoredScreenshot,
} from "./artifact-check-records.server";
import { ArtifactCheckRunnerError, type ArtifactCheckRunner } from "./artifact-check-runner.server";
import { PAGE_RUNTIME_PATH, pageRuntimeSource } from "./artifact-page-runtime.server";
import type { ArtifactReads } from "./artifact-reads.server";

const TRANSIENT_ERROR_CLASSES = new Set(["worker_unreachable", "worker_http_5xx"]);

export type ArtifactChecksDeps = {
  db: PrismaClient;
  reads: Pick<ArtifactReads, "read">;
  blobs: Pick<StoredArtifactBlobs, "read" | "put" | "use" | "release">;
  enabled: () => boolean;
  runner?: () => ArtifactCheckRunner | null;
  enqueue?: (job: ArtifactVersionCheckJob) => Promise<string | null>;
  timeoutMs?: () => number;
  logger?: ArtifactCheckLogger;
  now?: () => Date;
};

export class ArtifactChecks {
  readonly #logger: ArtifactCheckLogger;
  readonly #now: () => Date;

  constructor(private readonly deps: ArtifactChecksDeps) {
    this.#logger = deps.logger ?? defaultArtifactCheckLogger;
    this.#now = deps.now ?? (() => new Date());
  }

  async scheduleAfterPush(input: {
    workspaceId: string;
    artifactId: string;
    version: number;
    entryPath?: string;
    filesChanged: boolean;
  }): Promise<{ scheduled: boolean; checkId?: string; status?: string; skipReason?: string }> {
    let entryPath = input.entryPath;
    if (entryPath === undefined) {
      const versionRow = await this.deps.db.artifactVersion.findUnique({
        where: {
          artifactId_number: { artifactId: input.artifactId, number: input.version },
        },
        select: { entryPath: true },
      });
      if (!versionRow) return { scheduled: false };
      entryPath = versionRow.entryPath;
    }
    if (artifactKindOfPath(entryPath) !== "html") return { scheduled: false };
    if (!this.deps.enabled()) {
      this.#logger.info({
        event: "artifact_check.skipped",
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        version: input.version,
        reason: "checker_disabled",
      });
      return { scheduled: false, status: "skipped", skipReason: "checker_disabled" };
    }
    const existing = await this.deps.db.artifactVersionCheck.findUnique({
      where: {
        artifactId_version: { artifactId: input.artifactId, version: input.version },
      },
      select: { id: true, status: true, skipReason: true },
    });
    if (existing) {
      return {
        scheduled: existing.status === "pending",
        checkId: existing.id,
        status: existing.status,
        ...(existing.skipReason ? { skipReason: existing.skipReason } : {}),
      };
    }

    const now = this.#now();
    if (!input.filesChanged) {
      const row = await this.deps.db.artifactVersionCheck.create({
        data: {
          artifactId: input.artifactId,
          version: input.version,
          status: "skipped",
          skipReason: "unchanged_files",
          finishedAt: now,
        },
        select: { id: true },
      });
      this.#logger.info({
        event: "artifact_check.skipped",
        checkId: row.id,
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        version: input.version,
        reason: "unchanged_files",
      });
      return {
        scheduled: false,
        checkId: row.id,
        status: "skipped",
        skipReason: "unchanged_files",
      };
    }

    const superseded = await this.deps.db.artifactVersionCheck.updateMany({
      where: {
        artifactId: input.artifactId,
        version: { lt: input.version },
        status: "pending",
      },
      data: {
        status: "skipped",
        skipReason: "superseded",
        finishedAt: now,
      },
    });
    if (superseded.count > 0) {
      this.#logger.info({
        event: "artifact_check.superseded",
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        version: input.version,
        supersededCount: superseded.count,
      });
    }

    let row: { id: string };
    try {
      row = await this.deps.db.artifactVersionCheck.create({
        data: {
          artifactId: input.artifactId,
          version: input.version,
          status: "pending",
        },
        select: { id: true },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") {
        const raced = await this.deps.db.artifactVersionCheck.findUnique({
          where: {
            artifactId_version: { artifactId: input.artifactId, version: input.version },
          },
          select: { id: true, status: true, skipReason: true },
        });
        if (raced) {
          return {
            scheduled: raced.status === "pending",
            checkId: raced.id,
            status: raced.status,
            ...(raced.skipReason ? { skipReason: raced.skipReason } : {}),
          };
        }
      }
      throw error;
    }

    const job: ArtifactVersionCheckJob = {
      checkId: row.id,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      version: input.version,
    };
    try {
      const jobId = await this.deps.enqueue?.(job);
      if (!jobId) {
        await this.deps.db.artifactVersionCheck.update({
          where: { id: row.id },
          data: {
            status: "skipped",
            skipReason: "queue_unavailable",
            finishedAt: this.#now(),
          },
        });
        this.#logger.warn({
          event: "artifact_check.skipped",
          checkId: row.id,
          workspaceId: input.workspaceId,
          artifactId: input.artifactId,
          version: input.version,
          reason: "queue_unavailable",
        });
        return {
          scheduled: false,
          checkId: row.id,
          status: "skipped",
          skipReason: "queue_unavailable",
        };
      }
      this.#logger.info({
        event: "artifact_check.enqueued",
        checkId: row.id,
        jobId,
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        version: input.version,
        entryPath,
      });
      return { scheduled: true, checkId: row.id, status: "pending" };
    } catch (error) {
      await this.deps.db.artifactVersionCheck
        .update({
          where: { id: row.id },
          data: {
            status: "failed",
            errorClass: "enqueue_failed",
            finishedAt: this.#now(),
          },
        })
        .catch(() => {});
      this.#logger.error({
        event: "artifact_check.enqueue_failed",
        checkId: row.id,
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        version: input.version,
        error_type: errorType(error),
      });
      return { scheduled: false, checkId: row.id, status: "failed" };
    }
  }

  async runJob(job: ArtifactVersionCheckJob, options: { retryable?: boolean } = {}): Promise<void> {
    const startedAt = this.#now();
    const row = await this.deps.db.artifactVersionCheck.findUnique({
      where: { id: job.checkId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        artifactId: true,
        version: true,
      },
    });
    if (!row || (row.status !== "pending" && row.status !== "running")) return;

    const runner = this.deps.runner?.();
    if (!runner) {
      await this.deps.db.artifactVersionCheck.update({
        where: { id: row.id },
        data: { status: "skipped", skipReason: "checker_disabled", finishedAt: this.#now() },
      });
      this.#logger.info({
        event: "artifact_check.skipped",
        checkId: row.id,
        workspaceId: job.workspaceId,
        artifactId: job.artifactId,
        version: job.version,
        reason: "checker_disabled",
      });
      return;
    }

    const queueWaitMs = Math.max(0, startedAt.getTime() - row.createdAt.getTime());
    const claimed = await this.deps.db.artifactVersionCheck.updateMany({
      where: { id: row.id, status: { in: ["pending", "running"] } },
      data: { status: "running", startedAt },
    });
    if (claimed.count === 0) return;

    this.#logger.info({
      event: "artifact_check.started",
      checkId: row.id,
      workspaceId: job.workspaceId,
      artifactId: job.artifactId,
      version: job.version,
      queueWaitMs,
      runnerKind: runner.kind,
    });

    try {
      const versionRow = await this.deps.db.artifactVersion.findUnique({
        where: {
          artifactId_number: { artifactId: job.artifactId, number: job.version },
        },
        select: {
          entryPath: true,
          artifact: { select: { deletedAt: true } },
          files: { select: { path: true, sha256: true, sizeBytes: true, kind: true } },
        },
      });
      if (!versionRow || versionRow.artifact.deletedAt !== null) {
        await this.deps.db.artifactVersionCheck.update({
          where: { id: row.id },
          data: { status: "skipped", skipReason: "artifact_gone", finishedAt: this.#now() },
        });
        this.#logger.info({
          event: "artifact_check.skipped",
          checkId: row.id,
          workspaceId: job.workspaceId,
          artifactId: job.artifactId,
          version: job.version,
          reason: "artifact_gone",
        });
        return;
      }

      const bundle = await buildCheckBundle({
        workspaceId: job.workspaceId,
        artifactId: job.artifactId,
        entryPath: versionRow.entryPath,
        files: versionRow.files,
        blobs: this.deps.blobs,
      });

      const output = await runner.run({
        checkId: row.id,
        workspaceId: job.workspaceId,
        artifactId: job.artifactId,
        version: job.version,
        entryPath: versionRow.entryPath,
        origin: bundle.origin,
        csp: bundle.csp,
        runtimeJs: pageRuntimeSource(),
        allowedCdnHosts: ALLOWED_CDN_HOSTS,
        files: bundle.files,
        viewports: ARTIFACT_CHECK_VIEWPORTS,
        timeoutMs: this.deps.timeoutMs?.() ?? 45_000,
      });

      const findings = sanitizeFindings(output.findings);
      const storedShots: StoredScreenshot[] = [];
      for (const shot of output.screenshots) {
        if (shot.bytes.byteLength === 0 || shot.bytes.byteLength > ARTIFACT_CHECK_SHOT_MAX_BYTES)
          continue;
        const stored = await this.deps.blobs.put(job.workspaceId, shot.bytes);
        storedShots.push({
          shot: shot.shot,
          sha256: stored.sha256,
          contentType: shot.contentType,
          sizeBytes: shot.bytes.byteLength,
        });
        this.#logger.info({
          event: "artifact_check.shot_captured",
          checkId: row.id,
          artifactId: job.artifactId,
          version: job.version,
          shot: shot.shot,
          sizeBytes: shot.bytes.byteLength,
          durationMs: output.metrics?.shotDurationsMs?.[shot.shot] ?? null,
        });
      }

      const finishedAt = this.#now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
      const prunedVersions = await this.deps.db.$transaction(async (tx) => {
        if (storedShots.length > 0) {
          await this.deps.blobs.use(
            tx,
            job.workspaceId,
            storedShots.map((item) => item.sha256),
          );
        }
        await tx.artifactVersionCheck.update({
          where: { id: row.id },
          data: {
            status: "done",
            errorClass: null,
            findings: findings as unknown as Prisma.InputJsonValue,
            screenshots: storedShots as unknown as Prisma.InputJsonValue,
            durationMs,
            finishedAt,
          },
        });
        return this.#pruneOlderScreenshots(tx, job.workspaceId, job.artifactId);
      });

      this.#logger.info({
        event: "artifact_check.completed",
        checkId: row.id,
        workspaceId: job.workspaceId,
        artifactId: job.artifactId,
        version: job.version,
        durationMs,
        queueWaitMs,
        bundleFiles: bundle.files.length,
        bundleBytes: bundle.totalBytes,
        ...summarizeFindings(findings),
        ...summarizeShots(storedShots),
        shotDurationsMs: output.metrics?.shotDurationsMs ?? null,
        workerRssMb: output.metrics?.workerRssMb ?? null,
        browserLaunched: output.metrics?.browserLaunched ?? null,
        prunedVersions,
        runtimePath: PAGE_RUNTIME_PATH,
      });
    } catch (error) {
      const finishedAt = this.#now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
      const errorClass =
        error instanceof ArtifactCheckRunnerError ? error.errorClass : "runner_error";
      const shouldRetry = Boolean(options.retryable && TRANSIENT_ERROR_CLASSES.has(errorClass));
      if (shouldRetry) {
        await this.deps.db.artifactVersionCheck
          .update({
            where: { id: row.id },
            data: { status: "pending", errorClass },
          })
          .catch(() => {});
        this.#logger.warn({
          event: "artifact_check.retry_scheduled",
          checkId: row.id,
          workspaceId: job.workspaceId,
          artifactId: job.artifactId,
          version: job.version,
          durationMs,
          queueWaitMs,
          errorClass,
          error_type: errorType(error),
        });
        throw error;
      }
      await this.deps.db.artifactVersionCheck.update({
        where: { id: row.id },
        data: {
          status: "failed",
          errorClass,
          durationMs,
          finishedAt,
        },
      });
      this.#logger.error({
        event: "artifact_check.failed",
        checkId: row.id,
        workspaceId: job.workspaceId,
        artifactId: job.artifactId,
        version: job.version,
        durationMs,
        queueWaitMs,
        errorClass,
        error_type: errorType(error),
        detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }

  async readCheck(
    scope: { workspaceId: string; actor: ArtifactActor },
    input: { artifactId: string; version?: number },
  ): Promise<ArtifactCheckResponse> {
    const read = await this.deps.reads.read({
      workspaceId: scope.workspaceId,
      artifactId: input.artifactId,
      reader: scope.actor,
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    const targetVersion = input.version ?? read.artifact.currentVersion;
    const row = await this.deps.db.artifactVersionCheck.findUnique({
      where: {
        artifactId_version: { artifactId: read.artifact.id, version: targetVersion },
      },
    });
    const record = row ? toCheckRecord(row) : null;
    this.#logger.info({
      event: "artifact_check.polled",
      workspaceId: scope.workspaceId,
      artifactId: read.artifact.id,
      version: targetVersion,
      status: record?.status ?? "none",
      checksEnabled: this.deps.enabled(),
    });
    return {
      artifact: {
        id: read.artifact.id,
        title: read.artifact.title,
        currentVersion: read.artifact.currentVersion,
      },
      version: targetVersion,
      checksEnabled: this.deps.enabled(),
      check: record,
    };
  }

  async readCheckShot(
    scope: { workspaceId: string; actor: ArtifactActor },
    input: { artifactId: string; version?: number; shot: ArtifactCheckShot },
  ): Promise<ArtifactCheckShotResponse> {
    const read = await this.deps.reads.read({
      workspaceId: scope.workspaceId,
      artifactId: input.artifactId,
      reader: scope.actor,
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    const targetVersion = input.version ?? read.artifact.currentVersion;
    const row = await this.deps.db.artifactVersionCheck.findUnique({
      where: {
        artifactId_version: { artifactId: read.artifact.id, version: targetVersion },
      },
      select: { id: true, status: true, screenshots: true },
    });
    if (!row || row.status !== "done") throw new AppError("NOT_FOUND");
    const shot = parseStoredScreenshots(row.screenshots).find((item) => item.shot === input.shot);
    if (!shot) throw new AppError("NOT_FOUND");
    const bytes = await this.deps.blobs.read(scope.workspaceId, shot.sha256);
    if (!bytes) throw new AppError("NOT_FOUND");
    this.#logger.info({
      event: "artifact_check.shot_downloaded",
      checkId: row.id,
      workspaceId: scope.workspaceId,
      artifactId: read.artifact.id,
      version: targetVersion,
      shot: shot.shot,
      sizeBytes: bytes.byteLength,
    });
    return {
      artifactId: read.artifact.id,
      version: targetVersion,
      shot: shot.shot,
      contentType: shot.contentType,
      sizeBytes: bytes.byteLength,
      data: Buffer.from(bytes).toString("base64"),
    };
  }

  async #pruneOlderScreenshots(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    artifactId: string,
  ): Promise<number[]> {
    const done = await tx.artifactVersionCheck.findMany({
      where: { artifactId, status: "done" },
      orderBy: { version: "desc" },
      take: ARTIFACT_CHECK_RETENTION_VERSIONS + 25,
      select: { id: true, version: true, screenshots: true },
    });
    const toPrune = done.slice(ARTIFACT_CHECK_RETENTION_VERSIONS);
    const prunedVersions: number[] = [];
    const releasedSha256s: string[] = [];
    for (const row of toPrune) {
      const shots = parseStoredScreenshots(row.screenshots);
      if (shots.length === 0) continue;
      for (const shot of shots) releasedSha256s.push(shot.sha256);
      await tx.artifactVersionCheck.update({
        where: { id: row.id },
        data: { screenshots: [] },
      });
      prunedVersions.push(row.version);
    }
    if (releasedSha256s.length > 0) {
      await this.deps.blobs.release(tx, workspaceId, releasedSha256s);
      this.#logger.info({
        event: "artifact_check.retention_pruned",
        workspaceId,
        artifactId,
        prunedVersions,
        releasedBlobCount: releasedSha256s.length,
      });
    }
    return prunedVersions;
  }
}
