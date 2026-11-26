import {
  ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES,
  ARTIFACT_CHECK_MAX_BROKEN_IMAGES,
  ARTIFACT_CHECK_MAX_CONSOLE_ERRORS,
  ARTIFACT_CHECK_MAX_FAILED_ASSETS,
  ARTIFACT_CHECK_RETENTION_VERSIONS,
  isArtifactCheckShot,
  isArtifactCheckStatus,
  type ArtifactCheckFindings,
  type ArtifactCheckRecord,
  type ArtifactCheckShot,
} from "@lrm/coforge-sdk/agent";
import { z } from "zod";
import type { Prisma } from "#src/generated/prisma/client";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import type { ArtifactCheckLogger } from "./artifact-check-log.server";
import { artifactContentType } from "./artifact-content-types.server";
import {
  ArtifactCheckRunnerError,
  type ArtifactCheckBundleFile,
} from "./artifact-check-runner.server";
import { withPageRuntime } from "./artifact-page-runtime.server";
import { SANDBOX_CDN_HOSTS } from "./artifact-sandbox-cdns.server";
import { sandboxPageHeaders } from "./artifact-sandbox-response.server";

export const MAX_CHECK_BUNDLE_BYTES = 16 * 1024 * 1024;
export const INLINE_HOST_ORIGIN = "https://host.coforge.check";
const BLOB_READ_CONCURRENCY = 4;

export const ALLOWED_CDN_HOSTS = SANDBOX_CDN_HOSTS;

export type StoredScreenshot = {
  shot: ArtifactCheckShot;
  sha256: string;
  contentType: string;
  sizeBytes: number;
};

export function sanitizeFindings(raw: ArtifactCheckFindings): ArtifactCheckFindings {
  return {
    consoleErrors: (raw.consoleErrors ?? [])
      .slice(0, ARTIFACT_CHECK_MAX_CONSOLE_ERRORS)
      .map((e) => ({
        message: String(e.message ?? "").slice(0, 500),
        source: e.source ? String(e.source).slice(0, 300) : null,
        line: typeof e.line === "number" && Number.isFinite(e.line) ? Math.floor(e.line) : null,
      })),
    blockedResources: (raw.blockedResources ?? [])
      .slice(0, ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES)
      .map((item) => String(item).slice(0, 500)),
    blank: Boolean(raw.blank),
    phoneOverflow: raw.phoneOverflow
      ? {
          contentWidth: Math.max(0, Math.round(raw.phoneOverflow.contentWidth)),
          viewportWidth: Math.max(0, Math.round(raw.phoneOverflow.viewportWidth)),
        }
      : null,
    ...(raw.inlineOverflow !== undefined
      ? {
          inlineOverflow: raw.inlineOverflow
            ? {
                contentHeight: Math.max(0, Math.round(raw.inlineOverflow.contentHeight)),
                maxHeight: Math.max(0, Math.round(raw.inlineOverflow.maxHeight)),
                clipped: Boolean(raw.inlineOverflow.clipped),
              }
            : null,
        }
      : {}),
    ...(raw.pageCantScroll && raw.pageCantScroll.length > 0
      ? {
          pageCantScroll: raw.pageCantScroll.slice(0, 6).map((lock) => ({
            shot: lock.shot,
            viewportWidth: Math.max(0, Math.round(lock.viewportWidth)),
            viewportHeight: Math.max(0, Math.round(lock.viewportHeight)),
            contentHeight: Math.max(0, Math.round(lock.contentHeight)),
            hiddenHeight: Math.max(0, Math.round(lock.hiddenHeight)),
            heldBy: (lock.heldBy ?? []).slice(0, 5).map((item) => ({
              element: String(item.element ?? "").slice(0, 120),
              style: String(item.style ?? "").slice(0, 200),
            })),
          })),
        }
      : {}),
    ...(raw.brokenImages && raw.brokenImages.length > 0
      ? {
          brokenImages: raw.brokenImages
            .slice(0, ARTIFACT_CHECK_MAX_BROKEN_IMAGES)
            .map((item) => String(item).slice(0, 300)),
        }
      : {}),
    ...(raw.failedAssets && raw.failedAssets.length > 0
      ? {
          failedAssets: raw.failedAssets
            .slice(0, ARTIFACT_CHECK_MAX_FAILED_ASSETS)
            .map((item) => String(item).slice(0, 300)),
        }
      : {}),
  };
}

const storedScreenshotSchema = z.object({
  shot: z.custom<ArtifactCheckShot>(isArtifactCheckShot),
  sha256: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
});

export function parseStoredScreenshots(value: unknown): StoredScreenshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = storedScreenshotSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function toCheckRecord(row: {
  id: string;
  status: string;
  skipReason: string | null;
  errorClass: string | null;
  findings: unknown;
  screenshots: unknown;
  durationMs: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): ArtifactCheckRecord {
  const stored = parseStoredScreenshots(row.screenshots);
  return {
    id: row.id,
    status: isArtifactCheckStatus(row.status) ? row.status : "failed",
    skipReason: row.skipReason,
    errorClass: row.errorClass,
    findings:
      row.findings && typeof row.findings === "object"
        ? (row.findings as ArtifactCheckFindings)
        : null,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    screenshots: stored.map(({ shot, sizeBytes }) => ({ shot, sizeBytes })),
  };
}

export async function buildCheckBundle(input: {
  workspaceId: string;
  artifactId: string;
  entryPath: string;
  files: readonly { path: string; sha256: string; sizeBytes: number; kind: string }[];
  blobs: Pick<StoredArtifactBlobs, "read">;
}): Promise<{
  origin: string;
  csp: string;
  files: ArtifactCheckBundleFile[];
  totalBytes: number;
}> {
  const origin = `https://a-${input.artifactId}.coforge.check`;
  const csp =
    sandboxPageHeaders({
      pageOrigin: origin,
      frameAncestor: INLINE_HOST_ORIGIN,
      filePrefix: `${origin}/`,
    }).get("Content-Security-Policy") ?? "";

  let totalBytes = 0;
  for (const file of input.files) {
    totalBytes += file.sizeBytes;
    if (totalBytes > MAX_CHECK_BUNDLE_BYTES) {
      throw new ArtifactCheckRunnerError(
        "files_too_large",
        `Artifact files exceed ${MAX_CHECK_BUNDLE_BYTES} byte check bundle limit`,
      );
    }
  }

  const files: ArtifactCheckBundleFile[] = [];
  for (let i = 0; i < input.files.length; i += BLOB_READ_CONCURRENCY) {
    const batch = input.files.slice(i, i + BLOB_READ_CONCURRENCY);
    const batchFiles = await Promise.all(
      batch.map(async (file) => {
        const blob = await input.blobs.read(input.workspaceId, file.sha256);
        if (!blob) {
          throw new ArtifactCheckRunnerError("blob_missing", `Missing blob for ${file.path}`);
        }
        const contentType = artifactContentType(file.path, file.kind);
        const bytes =
          file.path === input.entryPath ? withPageRuntime(blob, INLINE_HOST_ORIGIN) : blob;
        return {
          path: file.path,
          contentType,
          base64: Buffer.from(bytes).toString("base64"),
        };
      }),
    );
    files.push(...batchFiles);
  }

  return { origin, csp, files, totalBytes };
}

export async function pruneOlderCheckScreenshots(input: {
  tx: Prisma.TransactionClient;
  blobs: Pick<StoredArtifactBlobs, "release">;
  logger: ArtifactCheckLogger;
  workspaceId: string;
  artifactId: string;
}): Promise<number[]> {
  const done = await input.tx.artifactVersionCheck.findMany({
    where: { artifactId: input.artifactId, status: "done" },
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
    await input.tx.artifactVersionCheck.update({
      where: { id: row.id },
      data: { screenshots: [] },
    });
    prunedVersions.push(row.version);
  }
  if (releasedSha256s.length > 0) {
    await input.blobs.release(input.tx, input.workspaceId, releasedSha256s);
    input.logger.info({
      event: "artifact_check.retention_pruned",
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      prunedVersions,
      releasedBlobCount: releasedSha256s.length,
    });
  }
  return prunedVersions;
}
