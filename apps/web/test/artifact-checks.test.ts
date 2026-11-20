import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES,
  ARTIFACT_CHECK_MAX_CONSOLE_ERRORS,
} from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import type { ArtifactCheckLogger } from "#src/server/artifacts/artifact-check-log.server";
import {
  ArtifactCheckRunnerError,
  type ArtifactCheckRunInput,
  type ArtifactCheckRunner,
} from "#src/server/artifacts/artifact-check-runner.server";
import { ArtifactChecks } from "#src/server/artifacts/artifact-checks.server";

type LoggedEvent = { level: "info" | "warn" | "error"; payload: Record<string, unknown> };

function makeLogger() {
  const events: LoggedEvent[] = [];
  const logger: ArtifactCheckLogger = {
    info: (payload) => events.push({ level: "info", payload }),
    warn: (payload) => events.push({ level: "warn", payload }),
    error: (payload) => events.push({ level: "error", payload }),
  };
  return { events, logger };
}

type CheckRow = {
  id: string;
  artifactId: string;
  version: number;
  status: string;
  skipReason: string | null;
  errorClass: string | null;
  findings: unknown;
  screenshots: unknown;
  durationMs: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

type VersionFixture = {
  artifactId: string;
  number: number;
  entryPath: string;
  deletedAt: Date | null;
  files: Array<{ path: string; sha256: string; sizeBytes: number; kind: string }>;
};

function makeHarness(options?: {
  enabled?: boolean;
  versions?: VersionFixture[];
  blobs?: Record<string, Uint8Array>;
  enqueue?: (job: unknown) => Promise<string | null>;
  runner?: ArtifactCheckRunner | null;
}) {
  const checks = new Map<string, CheckRow>();
  const versions = new Map<string, VersionFixture>(
    (options?.versions ?? []).map((v) => [`${v.artifactId}:${v.number}`, v]),
  );
  const blobStore = new Map<string, Uint8Array>(Object.entries(options?.blobs ?? {}));
  const usedBlobs: string[] = [];
  const releasedBlobs: string[] = [];
  let seq = 1;
  let nowMs = Date.parse("2026-11-20T12:00:00.000Z");

  const dbOps = {
    artifactVersionCheck: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; artifactId_version?: { artifactId: string; version: number } };
      }) => {
        if (where.id) return checks.get(where.id) ?? null;
        if (where.artifactId_version) {
          for (const row of checks.values()) {
            if (
              row.artifactId === where.artifactId_version.artifactId &&
              row.version === where.artifactId_version.version
            )
              return row;
          }
        }
        return null;
      },
      findMany: async ({ where }: { where: { artifactId: string; status: string } }) =>
        [...checks.values()]
          .filter((row) => row.artifactId === where.artifactId && row.status === where.status)
          .sort((a, b) => b.version - a.version),
      create: async ({
        data,
      }: {
        data: Partial<CheckRow> & { artifactId: string; version: number; status: string };
      }) => {
        const id = `chk-${seq++}`;
        const row: CheckRow = {
          id,
          artifactId: data.artifactId,
          version: data.version,
          status: data.status,
          skipReason: data.skipReason ?? null,
          errorClass: data.errorClass ?? null,
          findings: data.findings ?? null,
          screenshots: data.screenshots ?? [],
          durationMs: data.durationMs ?? null,
          createdAt: new Date(nowMs),
          startedAt: data.startedAt ?? null,
          finishedAt: data.finishedAt ?? null,
        };
        checks.set(id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<CheckRow> }) => {
        const existing = checks.get(where.id)!;
        const updated = { ...existing, ...data };
        checks.set(where.id, updated);
        return updated;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id?: string;
          artifactId?: string;
          version?: { lt: number };
          status: string | { in: string[] };
        };
        data: Partial<CheckRow>;
      }) => {
        let count = 0;
        const matchesStatus = (status: string) =>
          typeof where.status === "string"
            ? status === where.status
            : where.status.in.includes(status);
        for (const [id, row] of checks.entries()) {
          if (
            (where.id === undefined || row.id === where.id) &&
            (where.artifactId === undefined || row.artifactId === where.artifactId) &&
            (where.version === undefined || row.version < where.version.lt) &&
            matchesStatus(row.status)
          ) {
            checks.set(id, { ...row, ...data });
            count += 1;
          }
        }
        return { count };
      },
    },
    artifactVersion: {
      findUnique: async ({
        where,
      }: {
        where: { artifactId_number: { artifactId: string; number: number } };
      }) => {
        const key = `${where.artifactId_number.artifactId}:${where.artifactId_number.number}`;
        const version = versions.get(key);
        if (!version) return null;
        return {
          entryPath: version.entryPath,
          artifact: { deletedAt: version.deletedAt },
          files: version.files,
        };
      },
    },
  };

  const db = {
    ...dbOps,
    $transaction: async <T>(fn: (tx: typeof dbOps) => Promise<T>) => fn(dbOps),
  } as unknown as PrismaClient;

  const { events, logger } = makeLogger();
  let blobSeq = 1;
  const service = new ArtifactChecks({
    db,
    reads: {
      read: async (input) =>
        ({
          artifact: {
            id: input.artifactId,
            title: "Launch Dashboard",
            currentVersion: input.version ?? 1,
          },
        }) as never,
    },
    blobs: {
      read: async (_workspaceId, sha256) => blobStore.get(sha256) ?? null,
      put: async (_workspaceId, bytes) => {
        const sha256 = `shot-sha-${blobSeq++}`;
        blobStore.set(sha256, bytes);
        return { sha256, sizeBytes: bytes.byteLength, kind: "binary" as const };
      },
      use: async (_tx, _workspaceId, sha256s) => {
        usedBlobs.push(...sha256s);
        return [];
      },
      release: async (_tx, _workspaceId, sha256s) => {
        releasedBlobs.push(...sha256s);
      },
    },
    enabled: () => options?.enabled ?? true,
    runner: () => (options && "runner" in options ? (options.runner ?? null) : null),
    enqueue: options?.enqueue ?? (async () => `job-${seq}`),
    logger,
    now: () => {
      nowMs += 250;
      return new Date(nowMs);
    },
  });

  return { service, checks, blobStore, usedBlobs, releasedBlobs, events };
}

describe("ArtifactChecks.scheduleAfterPush", () => {
  test("ignores non-html artifacts and skips cleanly when checker is disabled", async () => {
    const h = makeHarness({ enabled: false });
    const md = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
      entryPath: "notes.md",
      filesChanged: true,
    });
    expect(md).toEqual({ scheduled: false });

    const html = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-2",
      version: 1,
      entryPath: "index.html",
      filesChanged: true,
    });
    expect(html).toEqual({
      scheduled: false,
      status: "skipped",
      skipReason: "checker_disabled",
    });
    expect(h.events.some((e) => e.payload.event === "artifact_check.skipped")).toBe(true);
  });

  test("records unchanged_files skip and resolves entryPath from DB when omitted", async () => {
    const h = makeHarness({
      versions: [
        {
          artifactId: "art-1",
          number: 2,
          entryPath: "index.html",
          deletedAt: null,
          files: [],
        },
      ],
    });
    const res = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 2,
      filesChanged: false,
    });
    expect(res.scheduled).toBe(false);
    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("unchanged_files");
  });

  test("supersedes older pending checks, enqueues job, and logs structured events", async () => {
    const enqueued: unknown[] = [];
    const h = makeHarness({
      enqueue: async (job) => {
        enqueued.push(job);
        return "boss-job-1";
      },
    });
    const first = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
      entryPath: "index.html",
      filesChanged: true,
    });
    const second = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 2,
      entryPath: "index.html",
      filesChanged: true,
    });
    expect(first.scheduled).toBe(true);
    expect(second.scheduled).toBe(true);
    expect(h.checks.get(first.checkId!)?.status).toBe("skipped");
    expect(h.checks.get(first.checkId!)?.skipReason).toBe("superseded");
    expect(h.checks.get(second.checkId!)?.status).toBe("pending");
    expect(enqueued).toHaveLength(2);
    expect(h.events.map((e) => e.payload.event)).toEqual([
      "artifact_check.enqueued",
      "artifact_check.superseded",
      "artifact_check.enqueued",
    ]);
  });

  test("marks skipped(queue_unavailable) when enqueue returns null", async () => {
    const h = makeHarness({ enqueue: async () => null });
    const res = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
      entryPath: "index.html",
      filesChanged: true,
    });
    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("queue_unavailable");
  });
});

describe("ArtifactChecks.runJob, retention, and reads", () => {
  test("bundles runtime-injected HTML, persists screenshots, sanitizes findings, and prunes older shots", async () => {
    const capturedInputs: ArtifactCheckRunInput[] = [];
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const versions: VersionFixture[] = [1, 2, 3, 4].map((number) => ({
      artifactId: "art-1",
      number,
      entryPath: "index.html",
      deletedAt: null,
      files: [
        {
          path: "index.html",
          sha256: `html-sha-${number}`,
          sizeBytes: 42,
          kind: "text",
        },
      ],
    }));
    const blobs: Record<string, Uint8Array> = {};
    for (const n of [1, 2, 3, 4]) {
      blobs[`html-sha-${n}`] = new TextEncoder().encode(
        `<!doctype html><html><body>v${n}</body></html>`,
      );
    }

    const runner: ArtifactCheckRunner = {
      kind: "mock-playwright",
      async run(input) {
        capturedInputs.push(input);
        return {
          findings: {
            consoleErrors: Array.from({ length: 15 }, (_, i) => ({
              message: `err-${i}`,
              source: "app.js",
              line: i + 1,
            })),
            blockedResources: Array.from(
              { length: 25 },
              (_, i) => `https://evil-${i}.example/x.js`,
            ),
            blank: false,
            phoneOverflow: { contentWidth: 480.4, viewportWidth: 390 },
            inlineOverflow: { contentHeight: 920.2, maxHeight: 800, clipped: true },
          },
          screenshots: [
            { shot: "desktop", contentType: "image/png", bytes: pngBytes },
            { shot: "phone", contentType: "image/png", bytes: pngBytes },
            { shot: "inline", contentType: "image/png", bytes: pngBytes },
          ],
          metrics: {
            shotDurationsMs: { desktop: 410, phone: 320, inline: 290 },
            workerRssMb: 182,
            browserLaunched: true,
          },
        };
      },
    };

    const h = makeHarness({ versions, blobs, runner });
    for (const version of [1, 2, 3, 4]) {
      const scheduled = await h.service.scheduleAfterPush({
        workspaceId: "ws-1",
        artifactId: "art-1",
        version,
        entryPath: "index.html",
        filesChanged: true,
      });
      await h.service.runJob({
        checkId: scheduled.checkId!,
        workspaceId: "ws-1",
        artifactId: "art-1",
        version,
      });
    }

    expect(capturedInputs).toHaveLength(4);
    const decodedHtml = Buffer.from(capturedInputs[0]!.files[0]!.base64, "base64").toString("utf8");
    expect(decodedHtml).toContain("/_coforge/runtime.js");
    expect(capturedInputs[0]!.csp).toContain("default-src 'none'");
    expect(capturedInputs[0]!.allowedCdnHosts).toContain("fonts.googleapis.com");

    const latest = await h.service.readCheck(
      { workspaceId: "ws-1", actor: { agentId: "agent-1" } },
      { artifactId: "art-1", version: 4 },
    );
    expect(latest.check?.status).toBe("done");
    expect(latest.check?.findings?.consoleErrors).toHaveLength(ARTIFACT_CHECK_MAX_CONSOLE_ERRORS);
    expect(latest.check?.findings?.blockedResources).toHaveLength(
      ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES,
    );
    expect(latest.check?.findings?.phoneOverflow).toEqual({
      contentWidth: 480,
      viewportWidth: 390,
    });
    expect(latest.check?.findings?.inlineOverflow).toEqual({
      contentHeight: 920,
      maxHeight: 800,
      clipped: true,
    });
    expect(latest.check?.screenshots.map((s) => s.shot)).toEqual(["desktop", "phone", "inline"]);

    const v1 = await h.service.readCheck(
      { workspaceId: "ws-1", actor: { agentId: "agent-1" } },
      { artifactId: "art-1", version: 1 },
    );
    expect(v1.check?.screenshots).toEqual([]);
    expect(h.releasedBlobs).toHaveLength(3);
    expect(h.events.some((e) => e.payload.event === "artifact_check.retention_pruned")).toBe(true);

    const shot = await h.service.readCheckShot(
      { workspaceId: "ws-1", actor: { agentId: "agent-1" } },
      { artifactId: "art-1", version: 4, shot: "inline" },
    );
    expect(shot.contentType).toBe("image/png");
    expect(Buffer.from(shot.data, "base64")).toEqual(Buffer.from(pngBytes));

    const prunedError = await h.service
      .readCheckShot(
        { workspaceId: "ws-1", actor: { agentId: "agent-1" } },
        { artifactId: "art-1", version: 1, shot: "desktop" },
      )
      .catch((error) => error);
    expect(isAppError(prunedError) && prunedError.code === "NOT_FOUND").toBe(true);
  });

  test("classifies runner errors into failed status and emits artifact_check.failed", async () => {
    const h = makeHarness({
      versions: [
        {
          artifactId: "art-1",
          number: 1,
          entryPath: "index.html",
          deletedAt: null,
          files: [{ path: "index.html", sha256: "sha-1", sizeBytes: 10, kind: "text" }],
        },
      ],
      blobs: { "sha-1": new TextEncoder().encode("<p>hi</p>") },
      runner: {
        kind: "mock",
        async run() {
          throw new ArtifactCheckRunnerError("worker_timeout", "timed out");
        },
      },
    });
    const scheduled = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
      entryPath: "index.html",
      filesChanged: true,
    });
    await h.service.runJob({
      checkId: scheduled.checkId!,
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
    });

    const row = h.checks.get(scheduled.checkId!)!;
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("worker_timeout");
    const failedEvent = h.events.find((e) => e.payload.event === "artifact_check.failed");
    expect(failedEvent?.level).toBe("error");
    expect(failedEvent?.payload.errorClass).toBe("worker_timeout");
  });

  test("resets row to pending and rethrows on transient worker_unreachable when retryable", async () => {
    const h = makeHarness({
      versions: [
        {
          artifactId: "art-1",
          number: 1,
          entryPath: "index.html",
          deletedAt: null,
          files: [{ path: "index.html", sha256: "sha-1", sizeBytes: 10, kind: "text" }],
        },
      ],
      blobs: { "sha-1": new TextEncoder().encode("<p>hi</p>") },
      runner: {
        kind: "mock",
        async run() {
          throw new ArtifactCheckRunnerError("worker_unreachable", "ECONNREFUSED");
        },
      },
    });
    const scheduled = await h.service.scheduleAfterPush({
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
      entryPath: "index.html",
      filesChanged: true,
    });
    const thrown = await h.service
      .runJob(
        {
          checkId: scheduled.checkId!,
          workspaceId: "ws-1",
          artifactId: "art-1",
          version: 1,
        },
        { retryable: true },
      )
      .catch((error) => error);
    expect(thrown).toBeInstanceOf(ArtifactCheckRunnerError);
    expect(h.checks.get(scheduled.checkId!)?.status).toBe("pending");
    expect(h.events.some((e) => e.payload.event === "artifact_check.retry_scheduled")).toBe(true);
  });
});
