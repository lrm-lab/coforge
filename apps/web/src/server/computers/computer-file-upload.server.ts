import {
  COMPUTER_FILE_MAX_BYTES,
  COMPUTER_FILE_SESSION_SECONDS,
  sanitizeComputerFileName,
  type ComputerFilePullRequest,
  type ComputerFilePullResult,
} from "@lrm/coforge-sdk/internal";
import type { FileStorage } from "#src/server/files/file-storage.server";

export type ComputerFileViewer = { userId: string; workspaceId: string };

export type ComputerFileUploadSessionRecord = {
  uploadId: string;
  workspaceId: string;
  computerId: string;
  userId: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  state: "pending" | "completed" | "failed";
  expiresAt: string;
};

export type ComputerFileUploadCreated = {
  uploadId: string;
  state: "pending";
  expiresAt: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string> };
};

export type ComputerFileUploadCompleteResponse =
  | { status: "ready"; path: string; fileName: string; sizeBytes: number }
  | { status: "offline" | "unsupported" | "timeout" | "unavailable" | "storage_unavailable" }
  | { status: "failed"; message: string };

export type PendingComputerFilePull = { request: ComputerFilePullRequest; userId: string };

export interface ComputerFileUploadSessions {
  put(session: ComputerFileUploadSessionRecord, ttlSeconds: number): Promise<void>;
  get(uploadId: string): Promise<ComputerFileUploadSessionRecord | undefined>;
  clear(uploadId: string): Promise<void>;
}

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

/**
 * Owner uploads that land in a Computer's `uploads/` directory: browser PUTs to storage with a
 * short-lived presigned URL, then complete verifies the object and asks the Computer to pull it.
 */
export class ComputerFileUploads {
  constructor(
    private readonly dependencies: {
      owned(viewer: ComputerFileViewer, computerId: string): Promise<boolean>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      supported(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      storage: FileStorage;
      sessions: ComputerFileUploadSessions;
      pullResults: ComputerFilePullResults;
      publishPull(request: ComputerFilePullRequest): Promise<void>;
    },
    private readonly timing: {
      now(): number;
      wait(ms: number): Promise<void>;
      timeoutMs: number;
      sessionExpiresInSeconds: number;
      pullExpiresInSeconds: number;
    } = {
      now: Date.now,
      wait: (ms) => Bun.sleep(ms),
      // 500 MiB on a modest Computer uplink can take several minutes; keep the browser wait and
      // the signed GET alive for the same window.
      timeoutMs: 600_000,
      sessionExpiresInSeconds: COMPUTER_FILE_SESSION_SECONDS,
      pullExpiresInSeconds: 900,
    },
  ) {}

  async create(
    viewer: ComputerFileViewer,
    computerId: string,
    input: { fileName: string; contentType: string; sizeBytes: number },
  ): Promise<
    | ComputerFileUploadCreated
    | { status: "unavailable" | "storage_unavailable" | "too_large" | "invalid_name" }
  > {
    if (!(await this.dependencies.owned(viewer, computerId))) return { status: "unavailable" };
    if (!this.dependencies.storage.presignPut || !this.dependencies.storage.presignGet)
      return { status: "storage_unavailable" };
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > COMPUTER_FILE_MAX_BYTES
    )
      return { status: "too_large" };
    let fileName: string;
    try {
      fileName = sanitizeComputerFileName(input.fileName);
    } catch {
      return { status: "invalid_name" };
    }
    const uploadId = crypto.randomUUID();
    const objectKey = `workspaces/${viewer.workspaceId}/computer-files/${computerId}/${uploadId}/original`;
    const expiresAt = new Date(
      this.timing.now() + this.timing.sessionExpiresInSeconds * 1000,
    ).toISOString();
    await this.dependencies.sessions.put(
      {
        uploadId,
        workspaceId: viewer.workspaceId,
        computerId,
        userId: viewer.userId,
        objectKey,
        fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        state: "pending",
        expiresAt,
      },
      this.timing.sessionExpiresInSeconds,
    );
    const upload = await this.dependencies.storage.presignPut(objectKey, {
      contentType: input.contentType,
      expiresInSeconds: this.timing.sessionExpiresInSeconds,
    });
    return {
      uploadId,
      state: "pending",
      expiresAt,
      upload: { method: "PUT", url: upload.url, headers: upload.headers },
    };
  }

  async complete(
    viewer: ComputerFileViewer,
    computerId: string,
    uploadId: string,
  ): Promise<ComputerFileUploadCompleteResponse> {
    if (!(await this.dependencies.owned(viewer, computerId))) return { status: "unavailable" };
    const storage = this.dependencies.storage;
    if (!storage.presignPut || !storage.presignGet) return { status: "storage_unavailable" };

    const session = await this.dependencies.sessions.get(uploadId);
    if (
      !session ||
      session.workspaceId !== viewer.workspaceId ||
      session.computerId !== computerId ||
      session.userId !== viewer.userId
    )
      return { status: "unavailable" };
    if (Date.parse(session.expiresAt) <= this.timing.now()) {
      await this.dependencies.sessions.clear(uploadId).catch(() => {});
      return { status: "failed", message: "upload session expired" };
    }

    const head = await storage.head(session.objectKey);
    if (!head) return { status: "failed", message: "uploaded object not found" };
    if (head.sizeBytes !== session.sizeBytes)
      return {
        status: "failed",
        message: `object size ${head.sizeBytes} does not match declared ${session.sizeBytes}`,
      };

    const availability = { workspaceId: viewer.workspaceId, computerId };
    const [online, supported] = await Promise.all([
      this.dependencies.online(availability),
      this.dependencies.supported(availability),
    ]);
    if (!online) return { status: "offline" };
    if (!supported) return { status: "unsupported" };

    const downloadUrl = await storage.presignGet(session.objectKey, {
      expiresInSeconds: this.timing.pullExpiresInSeconds,
    });
    const request: ComputerFilePullRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId,
      downloadUrl,
      fileName: session.fileName,
      sizeBytes: session.sizeBytes,
      contentType: session.contentType,
    };

    try {
      await this.dependencies.pullResults.begin({ request, userId: viewer.userId });
      await this.dependencies.publishPull(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      let attempt = 0;
      do {
        const result = await this.dependencies.pullResults.read(request.requestId);
        if (result) {
          if (
            !(await this.dependencies.owned(viewer, computerId)) ||
            !sameComputerFilePullScope(request, result)
          )
            return { status: "unavailable" };
          if (result.status === "ok") {
            await this.dependencies.sessions
              .put({ ...session, state: "completed" }, 60)
              .catch(() => {});
            return {
              status: "ready",
              path: result.path,
              fileName: session.fileName,
              sizeBytes: session.sizeBytes,
            };
          }
          await this.dependencies.sessions.put({ ...session, state: "failed" }, 60).catch(() => {});
          return {
            status: "failed",
            message: result.errorMessage || result.status,
          };
        }
        await this.timing.wait(pollDelayMs(attempt++));
      } while (this.timing.now() < deadline);
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await this.dependencies.pullResults.clear(request.requestId).catch(() => {});
    }
  }
}
