import {
  ARTIFACT_CHECK_SHOT_MAX_BYTES,
  ARTIFACT_CHECK_VIEWPORTS,
  isArtifactCheckShot,
  type ArtifactCheckFindings,
  type ArtifactCheckShot,
  type ArtifactCheckViewport,
} from "@lrm/coforge-sdk/agent";
import type { ArtifactCheckConfig } from "./artifact-check-config.server";
import { defaultArtifactCheckLogger, type ArtifactCheckLogger } from "./artifact-check-log.server";

export type ArtifactCheckBundleFile = {
  path: string;
  contentType: string;
  base64: string;
};

export type ArtifactCheckRunInput = {
  checkId: string;
  workspaceId: string;
  artifactId: string;
  version: number;
  entryPath: string;
  origin: string;
  csp: string;
  runtimeJs: string;
  allowedCdnHosts: readonly string[];
  files: readonly ArtifactCheckBundleFile[];
  viewports: readonly ArtifactCheckViewport[];
  timeoutMs: number;
};

export type ArtifactCheckCapturedShot = {
  shot: ArtifactCheckShot;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
};

export type ArtifactCheckRunMetrics = {
  shotDurationsMs?: Record<string, number>;
  workerRssMb?: number;
  browserLaunched?: boolean;
};

export type ArtifactCheckRunOutput = {
  findings: ArtifactCheckFindings;
  screenshots: ArtifactCheckCapturedShot[];
  metrics?: ArtifactCheckRunMetrics;
};

export type ArtifactCheckRunner = {
  readonly kind: string;
  run(input: ArtifactCheckRunInput): Promise<ArtifactCheckRunOutput>;
};

export class ArtifactCheckRunnerError extends Error {
  constructor(
    readonly errorClass: string,
    message: string,
  ) {
    super(message);
  }
}

type WorkerWireShot = {
  shot: unknown;
  contentType?: unknown;
  base64?: unknown;
};

type WorkerWireResponse = {
  findings?: unknown;
  screenshots?: unknown;
  metrics?: unknown;
};

function decodeShot(raw: WorkerWireShot): ArtifactCheckCapturedShot | null {
  if (!isArtifactCheckShot(raw.shot) || typeof raw.base64 !== "string") return null;
  const contentType =
    typeof raw.contentType === "string" && raw.contentType.startsWith("image/")
      ? raw.contentType
      : "image/png";
  const buffer = Buffer.from(raw.base64, "base64");
  if (buffer.byteLength === 0 || buffer.byteLength > ARTIFACT_CHECK_SHOT_MAX_BYTES) return null;
  const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength));
  bytes.set(buffer);
  return { shot: raw.shot, contentType, bytes };
}

export function createHttpArtifactCheckRunner(
  config: ArtifactCheckConfig,
  deps: {
    fetchImpl?: typeof fetch;
    logger?: ArtifactCheckLogger;
  } = {},
): ArtifactCheckRunner {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? defaultArtifactCheckLogger;
  return {
    kind: "http-playwright-sidecar",
    async run(input) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs + 5_000);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.secret) headers.Authorization = `Bearer ${config.secret}`;
        const response = await fetchImpl(`${config.workerUrl}/check`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            checkId: input.checkId,
            artifactId: input.artifactId,
            version: input.version,
            entryPath: input.entryPath,
            origin: input.origin,
            csp: input.csp,
            runtimeJs: input.runtimeJs,
            allowedCdnHosts: input.allowedCdnHosts,
            files: input.files,
            viewports: input.viewports.length > 0 ? input.viewports : ARTIFACT_CHECK_VIEWPORTS,
            timeoutMs: input.timeoutMs,
          }),
          signal: controller.signal,
        });
        const elapsedMs = Date.now() - startedAt;
        if (!response.ok) {
          const text = (await response.text().catch(() => "")).slice(0, 300);
          const errorClass =
            response.status === 408 || response.status === 504
              ? "worker_timeout"
              : response.status >= 500
                ? "worker_http_5xx"
                : "worker_http_4xx";
          logger.error({
            event: "artifact_check.worker_http_error",
            checkId: input.checkId,
            artifactId: input.artifactId,
            version: input.version,
            status: response.status,
            errorClass,
            durationMs: elapsedMs,
            detail: text,
          });
          throw new ArtifactCheckRunnerError(
            errorClass,
            `Checker worker returned HTTP ${response.status}`,
          );
        }
        const payload = (await response.json()) as WorkerWireResponse;
        if (!payload || typeof payload !== "object" || !payload.findings) {
          throw new ArtifactCheckRunnerError(
            "worker_invalid_response",
            "Checker worker returned malformed payload",
          );
        }
        const rawShots = Array.isArray(payload.screenshots)
          ? (payload.screenshots as WorkerWireShot[])
          : [];
        const screenshots: ArtifactCheckCapturedShot[] = [];
        for (const item of rawShots) {
          const decoded = decodeShot(item);
          if (decoded) screenshots.push(decoded);
        }
        return {
          findings: payload.findings as ArtifactCheckFindings,
          screenshots,
          metrics:
            payload.metrics && typeof payload.metrics === "object"
              ? (payload.metrics as ArtifactCheckRunMetrics)
              : undefined,
        };
      } catch (error) {
        if (error instanceof ArtifactCheckRunnerError) throw error;
        const aborted =
          error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        throw new ArtifactCheckRunnerError(
          aborted ? "worker_timeout" : "worker_unreachable",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
