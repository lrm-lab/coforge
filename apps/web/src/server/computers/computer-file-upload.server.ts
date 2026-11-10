import {
  COMPUTER_FILE_MAX_BYTES,
  sanitizeComputerFileName,
  type ComputerFilePullRequest,
  type ComputerFilePullResult,
} from "@lrm/coforge-sdk/internal";
import type { FileStorage } from "#src/server/files/file-storage.server";

export type ComputerFileViewer = { userId: string; workspaceId: string };

/** Every reason a start is refused or an upload fails: the ones the panel has a message for. */
export type ComputerFileUploadReason =
  | "too_large"
  | "invalid_name"
  | "unavailable"
  | "storage_unavailable"
  | "offline"
  | "unsupported"
  | "timeout"
  | "failed";

/** Why a start is refused: nothing was stored and no upload id exists. */
export type ComputerFileUploadStartRefusal = Exclude<
  ComputerFileUploadReason,
  "timeout" | "failed"
>;

/** Why a started upload ended without the file on the Computer. */
export type ComputerFileUploadFailureReason = Exclude<
  ComputerFileUploadReason,
  "too_large" | "invalid_name"
>;

export type ComputerFileUploadStart =
  | { status: "started"; uploadId: string }
  | { status: ComputerFileUploadStartRefusal };

/** How a started upload ended; `placed` carries the path the Computer used. */
export type ComputerFileUploadOutcome =
  | { status: "placed"; path: string; fileName: string; sizeBytes: number }
  | { status: "failed"; reason: ComputerFileUploadFailureReason; message?: string };

export type ComputerFileUploadRead = { status: "pending" } | ComputerFileUploadOutcome;

export type ComputerFileUploadScope = { workspaceId: string; computerId: string };

/** What the status store holds for one upload: its owner, and the outcome once there is one. */
export type ComputerFileUploadStatus = { userId: string; outcome?: ComputerFileUploadOutcome };

/**
 * The short-lived record of one upload, scoped to its Workspace and Computer. `begin` writes it
 * pending for a lease that `renew` keeps extending while the work runs; a record nobody renews
 * (the web process went away) expires, and a missing record reads as failed. `renew` makes a
 * missing record pending again, since the upload that renews it is alive, and never touches an
 * outcome.
 */
export interface ComputerFileUploadStatuses {
  begin(
    scope: ComputerFileUploadScope,
    uploadId: string,
    userId: string,
    leaseSeconds: number,
  ): Promise<void>;
  renew(
    scope: ComputerFileUploadScope,
    uploadId: string,
    userId: string,
    leaseSeconds: number,
  ): Promise<void>;
  settle(
    scope: ComputerFileUploadScope,
    uploadId: string,
    userId: string,
    outcome: ComputerFileUploadOutcome,
    ttlSeconds: number,
  ): Promise<void>;
  read(
    scope: ComputerFileUploadScope,
    uploadId: string,
  ): Promise<ComputerFileUploadStatus | undefined>;
}

export type PendingComputerFilePull = { request: ComputerFilePullRequest; userId: string };

export interface ComputerFilePullResults {
  begin(pending: PendingComputerFilePull): Promise<void>;
  read(requestId: string): Promise<ComputerFilePullResult | undefined>;
  clear(requestId: string): Promise<void>;
}

export function sameComputerFilePullScope(
  request: ComputerFilePullRequest,
  result: ComputerFilePullResult,
) {
  return (
    request.protocolMajor === result.protocolMajor &&
    request.requestId === result.requestId &&
    request.workspaceId === result.workspaceId &&
    request.computerId === result.computerId &&
    request.fileName === result.fileName &&
    request.sizeBytes === result.sizeBytes &&
    request.contentType === result.contentType
  );
}

function pollDelayMs(attempt: number) {
  return attempt < 25 ? 20 : 100;
}

export type ComputerFileUploadTiming = {
  now(): number;
  wait(ms: number): Promise<void>;
  /** The longest the object may take to reach storage. */
  storeTimeoutMs: number;
  /** The longest the Computer may take to pull the stored object. */
  pullTimeoutMs: number;
  /** How long a pending record lives without being renewed. */
  leaseSeconds: number;
  /** How often the running upload renews its pending record; well inside `leaseSeconds`. */
  leaseRenewMs: number;
  /** How long the outcome stays readable: a page polling from a throttled tab still finds it. */
  settledSeconds: number;
  /** How many times the outcome is written before giving up, `settleRetryMs` apart. */
  settleAttempts: number;
  settleRetryMs: number;
  /** The signed download link's lifetime; outlasts the pull. */
  pullExpiresInSeconds: number;
};

/**
 * The page stops asking after `COMPUTER_FILE_UPLOAD_CLIENT_DEADLINE_MS`
 * (`features/computers/computer-file-upload-poll.ts`), which must stay past
 * `storeTimeoutMs + pullTimeoutMs` so the page shows the server's own verdict.
 */
export const COMPUTER_FILE_UPLOAD_TIMING: ComputerFileUploadTiming = {
  now: Date.now,
  wait: (ms) => Bun.sleep(ms),
  storeTimeoutMs: 300_000,
  // A large file on a modest Computer uplink can take several minutes to pull.
  pullTimeoutMs: 600_000,
  // Long enough to ride out a Redis stall of several renewals.
  leaseSeconds: 90,
  leaseRenewMs: 15_000,
  settledSeconds: 600,
  settleAttempts: 5,
  settleRetryMs: 1_000,
  pullExpiresInSeconds: 900,
};

/** Whether `work` finished in `ms`; the work itself is not cancelled. Its failure is thrown. */
async function completesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

type UploadedFile = Blob & { name: string; type: string; size: number };

/**
 * A validated upload as the background work sees it: the file's size and type, and a way to store
 * the body that lets go of the body once called, so the buffered body is not kept alive through
 * the Computer's pull.
 */
type StartedUpload = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  store(objectKey: string): Promise<void>;
};

/**
 * A plain function on purpose: the closure's scope must not be the caller's. An async function's
 * parameters live in a scope its closures keep alive, which would hold `file` for as long as the
 * upload runs.
 */
function startedUpload(file: UploadedFile, fileName: string, storage: FileStorage): StartedUpload {
  const contentType = file.type || "application/octet-stream";
  let body: Blob | undefined = file;
  return {
    fileName,
    contentType,
    sizeBytes: file.size,
    store: (objectKey) => {
      const stored = body!;
      body = undefined;
      return storage.put(objectKey, stored, contentType);
    },
  };
}

/**
 * Owner uploads that land in a Computer's `uploads/` directory.
 *
 * Production closes a request idle for about ten seconds, and storing the object and the
 * Computer's pull take longer, so an upload is two calls. {@link ComputerFileUploads.start}
 * answers once the request is validated and the status record exists; the server then stores the
 * object and asks the Computer to pull a short-lived GET URL, and {@link ComputerFileUploads.read}
 * returns the record. Browser→OSS PUT is not used: OSS CORS for direct upload is still an ops
 * follow-up.
 */
export class ComputerFileUploads {
  constructor(
    private readonly dependencies: {
      owned(viewer: ComputerFileViewer, computerId: string): Promise<boolean>;
      online(scope: ComputerFileUploadScope): Promise<boolean>;
      supported(scope: ComputerFileUploadScope): Promise<boolean>;
      storage: FileStorage;
      statuses: ComputerFileUploadStatuses;
      pullResults: ComputerFilePullResults;
      publishPull(request: ComputerFilePullRequest): Promise<void>;
    },
    private readonly timing: ComputerFileUploadTiming = COMPUTER_FILE_UPLOAD_TIMING,
  ) {}

  /**
   * Validates the upload and records it pending, then stores and places it in the background.
   * Needs `presignGet` so the Daemon can fetch outbound; local-only storage cannot place files.
   * Throws only when the record cannot be written, because nothing has been started then.
   */
  async start(
    viewer: ComputerFileViewer,
    computerId: string,
    file: UploadedFile,
  ): Promise<ComputerFileUploadStart> {
    const { storage, statuses } = this.dependencies;
    if (!(await this.dependencies.owned(viewer, computerId))) return { status: "unavailable" };
    if (!storage.presignGet) return { status: "storage_unavailable" };
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > COMPUTER_FILE_MAX_BYTES)
      return { status: "too_large" };
    let fileName: string;
    try {
      fileName = sanitizeComputerFileName(file.name);
    } catch {
      return { status: "invalid_name" };
    }
    const scope = { workspaceId: viewer.workspaceId, computerId };
    const unreachable = await this.unreachable(scope);
    if (unreachable) return { status: unreachable };

    const uploadId = crypto.randomUUID();
    await statuses.begin(scope, uploadId, viewer.userId, this.timing.leaseSeconds);
    void this.run(viewer, scope, uploadId, startedUpload(file, fileName, storage));
    return { status: "started", uploadId };
  }

  /**
   * The upload's record. A missing record (the lease ran out, or the id is not the reader's)
   * reads as failed. A pending upload is answered from its record alone; an outcome is shown only
   * to someone who still owns the Computer.
   */
  async read(
    viewer: ComputerFileViewer,
    computerId: string,
    uploadId: string,
  ): Promise<ComputerFileUploadRead> {
    const status = await this.dependencies.statuses.read(
      { workspaceId: viewer.workspaceId, computerId },
      uploadId,
    );
    if (!status || status.userId !== viewer.userId) return { status: "failed", reason: "failed" };
    if (!status.outcome) return { status: "pending" };
    if (!(await this.dependencies.owned(viewer, computerId)))
      return { status: "failed", reason: "unavailable" };
    return status.outcome;
  }

  private async unreachable(scope: ComputerFileUploadScope) {
    const [online, supported] = await Promise.all([
      this.dependencies.online(scope),
      this.dependencies.supported(scope),
    ]);
    if (!online) return "offline";
    if (!supported) return "unsupported";
    return undefined;
  }

  /**
   * Runs one started upload to its end and always records how it ended; never rejects. The stored
   * object only serves the Computer's pull, so it is removed once the outcome is known. A
   * shutdown in between leaves it, and a file the Computer already pulled placed though the page
   * reads failed.
   */
  private async run(
    viewer: ComputerFileViewer,
    scope: ComputerFileUploadScope,
    uploadId: string,
    upload: StartedUpload,
  ) {
    const { statuses, storage } = this.dependencies;
    const objectKey = `workspaces/${scope.workspaceId}/computer-files/${scope.computerId}/${uploadId}/original`;
    let renewing: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing
        .then(() => statuses.renew(scope, uploadId, viewer.userId, this.timing.leaseSeconds))
        .catch(() => {});
    }, this.timing.leaseRenewMs);
    timer.unref();
    let outcome: ComputerFileUploadOutcome;
    try {
      outcome = await this.place(viewer, scope, objectKey, upload);
    } catch {
      outcome = { status: "failed", reason: "unavailable" };
    } finally {
      clearInterval(timer);
    }
    // A renewal still in flight must land before the outcome, or it would shorten its lifetime.
    await renewing;
    await this.settle(scope, uploadId, viewer.userId, outcome);
    await storage.remove(objectKey).catch(() => {});
  }

  /** Writes the outcome, again after a short pause if the write fails, so a success is not lost. */
  private async settle(
    scope: ComputerFileUploadScope,
    uploadId: string,
    userId: string,
    outcome: ComputerFileUploadOutcome,
  ) {
    for (let attempt = 1; attempt <= this.timing.settleAttempts; attempt++) {
      try {
        await this.dependencies.statuses.settle(
          scope,
          uploadId,
          userId,
          outcome,
          this.timing.settledSeconds,
        );
        return;
      } catch {
        if (attempt < this.timing.settleAttempts) await this.timing.wait(this.timing.settleRetryMs);
      }
    }
  }

  private async place(
    viewer: ComputerFileViewer,
    scope: ComputerFileUploadScope,
    objectKey: string,
    upload: StartedUpload,
  ): Promise<ComputerFileUploadOutcome> {
    const { storage, pullResults } = this.dependencies;
    if (!storage.presignGet) return { status: "failed", reason: "storage_unavailable" };
    try {
      // A store that outlasts its bound is a plain failure; its cause is not the user's to read.
      if (!(await completesWithin(upload.store(objectKey), this.timing.storeTimeoutMs)))
        return { status: "failed", reason: "failed" };
    } catch (error) {
      return {
        status: "failed",
        reason: "failed",
        message: error instanceof Error ? error.message.slice(0, 200) : "storage put failed",
      };
    }

    const unreachable = await this.unreachable(scope);
    if (unreachable) return { status: "failed", reason: unreachable };

    const downloadUrl = await storage.presignGet(objectKey, {
      expiresInSeconds: this.timing.pullExpiresInSeconds,
    });
    const request: ComputerFilePullRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
      downloadUrl,
      fileName: upload.fileName,
      sizeBytes: upload.sizeBytes,
      contentType: upload.contentType,
    };
    try {
      await pullResults.begin({ request, userId: viewer.userId });
      await this.dependencies.publishPull(request);
      const deadline = this.timing.now() + this.timing.pullTimeoutMs;
      let attempt = 0;
      do {
        const result = await pullResults.read(request.requestId);
        if (result) {
          if (
            !(await this.dependencies.owned(viewer, scope.computerId)) ||
            !sameComputerFilePullScope(request, result)
          )
            return { status: "failed", reason: "unavailable" };
          if (result.status === "ok")
            return {
              status: "placed",
              path: result.path,
              fileName: upload.fileName,
              sizeBytes: upload.sizeBytes,
            };
          return {
            status: "failed",
            reason: "failed",
            message: result.errorMessage || result.status,
          };
        }
        await this.timing.wait(pollDelayMs(attempt++));
      } while (this.timing.now() < deadline);
      return { status: "failed", reason: "timeout" };
    } catch {
      return { status: "failed", reason: "unavailable" };
    } finally {
      await pullResults.clear(request.requestId).catch(() => {});
    }
  }
}
