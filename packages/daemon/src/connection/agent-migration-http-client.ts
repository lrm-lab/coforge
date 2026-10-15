import { isRecord } from "@lrm/coforge-sdk/internal";
import {
  AgentMigrationRemoteError,
  type AgentMigrationServer,
  type AgentMigrationSignedUrl,
  type AgentMigrationStepResult,
  type AgentMigrationView,
} from "#src/agent-migration/transfer-ports";

/** One server call's time limit; the caller's retry loop is bounded by the migration's lease. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The route's limit on a failure's detail. */
const MAX_ERROR_DETAIL = 2000;

const STATES = new Set<string>([
  "requested",
  "source_stopped",
  "uploaded",
  "placing",
  "switched",
  "completed",
  "canceled",
  "failed",
]);

const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const isText = (value: unknown) => typeof value === "string" && value.length > 0;

function isMigration(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    isText(value.id) &&
    STATES.has(value.state as string) &&
    isCount(value.generation) &&
    isCount(value.revision)
  );
}

function isManifest(value: unknown) {
  return (
    isRecord(value) &&
    isText(value.sha256) &&
    isCount(value.sizeBytes) &&
    Array.isArray(value.chunks) &&
    value.chunks.every(
      (chunk) =>
        isRecord(chunk) &&
        isCount(chunk.index) &&
        isCount(chunk.offsetBytes) &&
        isCount(chunk.sizeBytes) &&
        isText(chunk.sha256),
    )
  );
}

/**
 * The shape each operation answers with. The manifest is checked only as far as fetching chunks
 * needs; the bundle commit verifies every byte and total against it.
 */
const ANSWERS = {
  view: (value: unknown) =>
    isRecord(value) &&
    isMigration(value.migration) &&
    (value.migration.role === "source" || value.migration.role === "target") &&
    isText(value.migration.agentId) &&
    isText(value.migration.sourceComputerId) &&
    isText(value.migration.targetComputerId) &&
    (value.manifest === null || isManifest(value.manifest)),
  step: (value: unknown) =>
    isRecord(value) &&
    (value.status === "advanced" ||
      value.status === "already_applied" ||
      value.status === "failed") &&
    isMigration(value.migration),
  upload_url: (value: unknown) =>
    isRecord(value) &&
    isText(value.url) &&
    isRecord(value.headers) &&
    Object.values(value.headers).every((header) => typeof header === "string"),
  download_url: (value: unknown) => isRecord(value) && isText(value.url),
};

/**
 * Whether asking the route again may succeed: a transient status, except `unavailable`, which
 * says this deployment has no migration bucket and will not grow one before the lease ends.
 */
function retryable(status: number, code: string) {
  if (code === "unavailable") return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * The server's Agent migration route over HTTPS, authenticated with this Computer's daemon API
 * key: one POST per operation, `version: 1` and its name in `operation`. A refusal becomes an
 * `AgentMigrationRemoteError` carrying the route's code; a caller's abort propagates as itself.
 */
export class AgentMigrationHttpClient implements AgentMigrationServer {
  constructor(private readonly options: { endpoint: () => string; daemonApiKey: () => string }) {}

  view(migrationId: string, signal?: AbortSignal) {
    return this.#call<AgentMigrationView>(ANSWERS.view, { operation: "view", migrationId }, signal);
  }

  step(input: Parameters<AgentMigrationServer["step"]>[0]) {
    return this.#call<AgentMigrationStepResult>(ANSWERS.step, { operation: "step", ...input });
  }

  uploadUrl(input: Parameters<AgentMigrationServer["uploadUrl"]>[0], signal?: AbortSignal) {
    return this.#call<AgentMigrationSignedUrl>(
      ANSWERS.upload_url,
      { operation: "upload_url", ...input },
      signal,
    );
  }

  downloadUrl(input: Parameters<AgentMigrationServer["downloadUrl"]>[0], signal?: AbortSignal) {
    return this.#call<{ url: string }>(
      ANSWERS.download_url,
      { operation: "download_url", ...input },
      signal,
    );
  }

  completeUpload(input: Parameters<AgentMigrationServer["completeUpload"]>[0]) {
    return this.#call<AgentMigrationStepResult>(ANSWERS.step, {
      operation: "upload_complete",
      ...input,
    });
  }

  fail(input: Parameters<AgentMigrationServer["fail"]>[0]) {
    return this.#call<AgentMigrationStepResult>(ANSWERS.step, {
      operation: "fail",
      ...input,
      ...(input.errorDetail === undefined
        ? {}
        : { errorDetail: input.errorDetail.slice(0, MAX_ERROR_DETAIL) }),
    });
  }

  async #call<T>(
    valid: (value: unknown) => boolean,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    // Outside the try: an unconfigured endpoint is not a network failure worth retrying.
    const url = this.options.endpoint();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.daemonApiKey()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, version: 1 }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AgentMigrationRemoteError("network", true, (error as Error).message);
    }
    const answer = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (!response.ok) {
      const code = typeof answer?.error === "string" ? answer.error : "unknown";
      throw new AgentMigrationRemoteError(
        code,
        retryable(response.status, code),
        String(response.status),
      );
    }
    if (!valid(answer)) throw new AgentMigrationRemoteError("invalid_response", false);
    return answer as T;
  }
}
