import { expect, test } from "bun:test";
import {
  ComputerFileUploads,
  type ComputerFileUploadSessionRecord,
  type ComputerFileUploadSessions,
  type ComputerFilePullResults,
  type PendingComputerFilePull,
} from "#src/server/computers/computer-file-upload.server";
import type { ComputerFilePullRequest, ComputerFilePullResult } from "@lrm/coforge-sdk/internal";
import type { FileStorage } from "#src/server/files/file-storage.server";

const viewer = { userId: "user-1", workspaceId: "ws-1" };
const computerId = "pc-1";

class MemorySessions implements ComputerFileUploadSessions {
  readonly map = new Map<string, ComputerFileUploadSessionRecord>();
  async put(session: ComputerFileUploadSessionRecord) {
    this.map.set(session.uploadId, session);
  }
  async get(uploadId: string) {
    return this.map.get(uploadId);
  }
  async clear(uploadId: string) {
    this.map.delete(uploadId);
  }
}

class MemoryPullResults implements ComputerFilePullResults {
  pending?: PendingComputerFilePull;
  result?: ComputerFilePullResult;
  async begin(pending: PendingComputerFilePull) {
    this.pending = pending;
  }
  async read(requestId: string) {
    return this.result?.requestId === requestId ? this.result : undefined;
  }
  async clear() {
    this.pending = undefined;
    this.result = undefined;
  }
}

function storage(options: {
  putUrl?: string;
  getUrl?: string;
  head?: { sizeBytes: number; contentType: string | null } | null;
}): FileStorage {
  return {
    put: async () => {},
    open: async () => null,
    remove: async () => {},
    head: async () => options.head ?? null,
    presignPut: async () => ({
      url: options.putUrl ?? "https://files.example/put",
      headers: { "Content-Type": "text/plain" },
    }),
    presignGet: async () => options.getUrl ?? "https://files.example/get",
  };
}

test("create refuses when direct upload storage is missing", async () => {
  const uploads = new ComputerFileUploads({
    owned: async () => true,
    online: async () => true,
    supported: async () => true,
    storage: {
      put: async () => {},
      open: async () => null,
      remove: async () => {},
      head: async () => null,
    },
    sessions: new MemorySessions(),
    pullResults: new MemoryPullResults(),
    publishPull: async () => {},
  });
  expect(
    await uploads.create(viewer, computerId, {
      fileName: "a.txt",
      contentType: "text/plain",
      sizeBytes: 3,
    }),
  ).toEqual({ status: "storage_unavailable" });
});

test("complete verifies the object then waits for the Computer pull", async () => {
  const sessions = new MemorySessions();
  const pullResults = new MemoryPullResults();
  let published: ComputerFilePullRequest | undefined;
  const uploads = new ComputerFileUploads(
    {
      owned: async () => true,
      online: async () => true,
      supported: async () => true,
      storage: storage({ head: { sizeBytes: 5, contentType: "text/plain" } }),
      sessions,
      pullResults,
      publishPull: async (request) => {
        published = request;
        pullResults.result = {
          ...request,
          status: "ok",
          path: "/workspace/uploads/notes.txt",
          errorMessage: "",
        };
      },
    },
    {
      now: () => 1_000,
      wait: async () => {},
      timeoutMs: 1_000,
      sessionExpiresInSeconds: 900,
      pullExpiresInSeconds: 600,
    },
  );

  const created = await uploads.create(viewer, computerId, {
    fileName: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 5,
  });
  expect("uploadId" in created).toBe(true);
  if (!("uploadId" in created)) return;

  const completed = await uploads.complete(viewer, computerId, created.uploadId);
  expect(completed).toEqual({
    status: "ready",
    path: "/workspace/uploads/notes.txt",
    fileName: "notes.txt",
    sizeBytes: 5,
  });
  expect(published?.fileName).toBe("notes.txt");
  expect(published?.downloadUrl).toBe("https://files.example/get");
});

test("ingest stores the file then waits for the Computer pull", async () => {
  const pullResults = new MemoryPullResults();
  let putKey: string | undefined;
  let published: ComputerFilePullRequest | undefined;
  const uploads = new ComputerFileUploads(
    {
      owned: async () => true,
      online: async () => true,
      supported: async () => true,
      storage: {
        ...storage({}),
        put: async (objectKey) => {
          putKey = objectKey;
        },
      },
      sessions: new MemorySessions(),
      pullResults,
      publishPull: async (request) => {
        published = request;
        pullResults.result = {
          ...request,
          status: "ok",
          path: "/workspace/uploads/notes.txt",
          errorMessage: "",
        };
      },
    },
    {
      now: () => 1_000,
      wait: async () => {},
      timeoutMs: 1_000,
      sessionExpiresInSeconds: 900,
      pullExpiresInSeconds: 600,
    },
  );
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  expect(await uploads.ingest(viewer, computerId, file)).toEqual({
    status: "ready",
    path: "/workspace/uploads/notes.txt",
    fileName: "notes.txt",
    sizeBytes: 5,
  });
  expect(putKey).toContain("/computer-files/");
  expect(published?.downloadUrl).toBe("https://files.example/get");
});

test("complete reports offline without publishing a pull", async () => {
  const sessions = new MemorySessions();
  let published = false;
  const uploads = new ComputerFileUploads(
    {
      owned: async () => true,
      online: async () => false,
      supported: async () => true,
      storage: storage({ head: { sizeBytes: 2, contentType: "text/plain" } }),
      sessions,
      pullResults: new MemoryPullResults(),
      publishPull: async () => {
        published = true;
      },
    },
    {
      now: () => 1_000,
      wait: async () => {},
      timeoutMs: 1_000,
      sessionExpiresInSeconds: 900,
      pullExpiresInSeconds: 600,
    },
  );
  const created = await uploads.create(viewer, computerId, {
    fileName: "a.txt",
    contentType: "text/plain",
    sizeBytes: 2,
  });
  if (!("uploadId" in created)) throw new Error("expected create");
  expect(await uploads.complete(viewer, computerId, created.uploadId)).toEqual({
    status: "offline",
  });
  expect(published).toBe(false);
});
