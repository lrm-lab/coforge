import type {
  ComputerFilePullResults,
  ComputerFileUploadOutcome,
  ComputerFileUploadScope,
  ComputerFileUploadStatus,
  ComputerFileUploadStatuses,
  ComputerFileUploadTiming,
  PendingComputerFilePull,
} from "#src/server/computers/computer-file-upload.server";
import { ComputerFileUploads } from "#src/server/computers/computer-file-upload.server";
import type { ComputerFilePullRequest, ComputerFilePullResult } from "@lrm/coforge-sdk/internal";
import type { FileStorage } from "#src/server/files/file-storage.server";

/** In-memory stand-ins for the upload's boundaries, shared by the upload's suites. */
export const viewer = { userId: "user-1", workspaceId: "ws-1" };
export const computerId = "pc-1";
export const scope: ComputerFileUploadScope = { workspaceId: "ws-1", computerId: "pc-1" };

export const SETTLE_ATTEMPTS = 3;

export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

/** The record store, which also tells the test when the upload reached its terminal write. */
export class MemoryStatuses implements ComputerFileUploadStatuses {
  readonly records = new Map<string, ComputerFileUploadStatus>();
  readonly calls: string[] = [];
  readonly leases: number[] = [];
  settledTtl?: number;
  readonly settled = deferred();
  readonly renewed = deferred();
  readonly recreated = deferred();
  /** How many settle writes fail before one lands. */
  settleFailures = 0;
  settleAttempts = 0;
  failBegin = false;

  private key(at: ComputerFileUploadScope, uploadId: string) {
    return `${at.workspaceId}/${at.computerId}/${uploadId}`;
  }
  async begin(at: ComputerFileUploadScope, uploadId: string, userId: string, lease: number) {
    if (this.failBegin) throw new Error("redis is down");
    this.calls.push("begin");
    this.leases.push(lease);
    this.records.set(this.key(at, uploadId), { userId });
  }
  async renew(at: ComputerFileUploadScope, uploadId: string, userId: string, lease: number) {
    this.calls.push(this.calls.includes("settle") ? "renew-after-settle" : "renew");
    this.leases.push(lease);
    // Like the store: a missing record is made pending again, a present one is left as it is.
    if (!this.records.has(this.key(at, uploadId))) {
      this.records.set(this.key(at, uploadId), { userId });
      this.recreated.resolve();
    }
    this.renewed.resolve();
  }
  async settle(
    at: ComputerFileUploadScope,
    uploadId: string,
    userId: string,
    outcome: ComputerFileUploadOutcome,
    ttl: number,
  ) {
    this.calls.push("settle");
    this.settledTtl = ttl;
    this.settleAttempts += 1;
    if (this.settleAttempts <= this.settleFailures) {
      // Giving up is the last attempt the upload makes.
      if (this.settleAttempts >= SETTLE_ATTEMPTS) this.settled.resolve();
      throw new Error("redis is down");
    }
    this.records.set(this.key(at, uploadId), { userId, outcome });
    this.settled.resolve();
  }
  async read(at: ComputerFileUploadScope, uploadId: string) {
    this.calls.push("read");
    return this.records.get(this.key(at, uploadId));
  }
  /** What Redis does to a pending record nobody renews. */
  expire(at: ComputerFileUploadScope, uploadId: string) {
    this.records.delete(this.key(at, uploadId));
  }
}

export class MemoryPullResults implements ComputerFilePullResults {
  pending?: PendingComputerFilePull;
  result?: ComputerFilePullResult;
  cleared = 0;
  /** The Computer answers as soon as it is asked. */
  answerWhenAsked?: (request: ComputerFilePullRequest) => ComputerFilePullResult;
  async begin(pending: PendingComputerFilePull) {
    this.pending = pending;
    this.result = this.answerWhenAsked?.(pending.request);
  }
  async read(requestId: string) {
    return this.result?.requestId === requestId ? this.result : undefined;
  }
  async clear() {
    this.cleared += 1;
    this.pending = undefined;
    this.result = undefined;
  }
}

/** Parks the pull's wait between reads until the test lets it go on. */
export class PullWaits {
  private readonly parked = deferred();
  private readonly released = deferred();
  wait = async () => {
    this.parked.resolve();
    await this.released.promise;
  };
  parkedInWait() {
    return this.parked.promise;
  }
  resume() {
    this.released.resolve();
  }
}

export function storage(
  options: {
    put?: FileStorage["put"];
    remove?: FileStorage["remove"];
    presignGet?: boolean;
  } = {},
): FileStorage {
  return {
    put: options.put ?? (async () => {}),
    open: async () => null,
    remove: options.remove ?? (async () => {}),
    head: async () => null,
    ...(options.presignGet === false
      ? {}
      : { presignGet: async () => "https://files.example/get" }),
  };
}

/** Five bytes, so the declared type is the one the Computer is asked to pull. */
export const hello = () => new File([new Uint8Array(5)], "notes.txt", { type: "application/pdf" });

export const answer = (
  request: ComputerFilePullRequest,
  rest: Partial<ComputerFilePullResult> = {},
): ComputerFilePullResult => ({
  ...request,
  status: "ok",
  path: "/workspace/uploads/notes.txt",
  errorMessage: "",
  ...rest,
});

/** A clock that moves on every look, so a pull nobody answers reaches its deadline. */
export const timing = (
  overrides: Partial<ComputerFileUploadTiming> = {},
): ComputerFileUploadTiming => ({
  now: (
    (time) => () =>
      (time += 100)
  )(0),
  wait: async () => {},
  storeTimeoutMs: 5_000,
  pullTimeoutMs: 1_000,
  leaseSeconds: 30,
  leaseRenewMs: 3_600_000,
  settledSeconds: 600,
  settleAttempts: SETTLE_ATTEMPTS,
  settleRetryMs: 1_000,
  pullExpiresInSeconds: 900,
  ...overrides,
});

export function harness(
  options: {
    owned?: () => Promise<boolean>;
    online?: () => Promise<boolean>;
    supported?: () => Promise<boolean>;
    storage?: FileStorage;
    timing?: Partial<ComputerFileUploadTiming>;
    publishPull?: (request: ComputerFilePullRequest) => Promise<void>;
  } = {},
) {
  const statuses = new MemoryStatuses();
  const pullResults = new MemoryPullResults();
  const published: ComputerFilePullRequest[] = [];
  const stored: string[] = [];
  const removed: string[] = [];
  const removal = deferred();
  const base = options.storage ?? storage();
  const uploads = new ComputerFileUploads(
    {
      owned: options.owned ?? (async () => true),
      online: options.online ?? (async () => true),
      supported: options.supported ?? (async () => true),
      storage: {
        ...base,
        put: async (objectKey, body, contentType) => {
          stored.push(objectKey);
          await base.put(objectKey, body, contentType);
        },
        remove: async (objectKey) => {
          removed.push(objectKey);
          removal.resolve();
          await base.remove(objectKey);
        },
      },
      statuses,
      pullResults,
      publishPull:
        options.publishPull ??
        (async (request) => {
          published.push(request);
        }),
    },
    timing(options.timing),
  );
  const start = async (file: File = hello()) => {
    const started = await uploads.start(viewer, computerId, file);
    if (started.status !== "started") throw new Error(`not started: ${started.status}`);
    return started.uploadId;
  };
  return { uploads, statuses, pullResults, published, stored, removed, removal, start };
}
