import { expect, test } from "bun:test";
import { COMPUTER_FILE_MAX_BYTES } from "@lrm/coforge-sdk/internal";
import {
  answer,
  computerId,
  deferred,
  harness,
  hello,
  PullWaits,
  storage,
  viewer,
} from "./helpers/computer-file-upload-harness";

/**
 * Owner uploads are two calls because production closes a request idle for about ten seconds:
 * `start` answers once the request is validated and recorded, the server stores the object and
 * the Computer pulls it afterwards, and `read` returns the record.
 */
test("start answers while the object is still being stored, and the record reads pending", async () => {
  const putStarted = deferred();
  const putGate = deferred();
  const { uploads, statuses, published, stored, start } = harness({
    storage: storage({
      put: async () => {
        putStarted.resolve();
        await putGate.promise;
      },
    }),
  });
  try {
    const uploadId = await start();
    await putStarted.promise;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(`workspaces/ws-1/computer-files/pc-1/${uploadId}/original`);
    // Nothing has been asked of the Computer yet, and the upload has not ended.
    expect(published).toHaveLength(0);
    expect(await uploads.read(viewer, computerId, uploadId)).toEqual({ status: "pending" });
    expect(statuses.leases).toEqual([30]);
  } finally {
    putGate.resolve();
    await statuses.settled.promise;
  }
});

test("the Computer's pull ends the upload as placed, at the path the Computer used", async () => {
  const waits = new PullWaits();
  const { uploads, statuses, pullResults, published, removed, removal, start } = harness({
    timing: { wait: waits.wait },
  });
  const uploadId = await start();
  await waits.parkedInWait();
  // The pull is in flight: published, and the record is still pending.
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    workspaceId: "ws-1",
    computerId: "pc-1",
    downloadUrl: "https://files.example/get",
    fileName: "notes.txt",
    sizeBytes: 5,
    contentType: "application/pdf",
  });
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({ status: "pending" });

  pullResults.result = answer(published[0]!, { path: "/workspace/uploads/notes (1).txt" });
  waits.resume();
  await statuses.settled.promise;
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({
    status: "placed",
    path: "/workspace/uploads/notes (1).txt",
    fileName: "notes.txt",
    sizeBytes: 5,
  });
  expect(pullResults.cleared).toBe(1);
  // The outcome stays readable for minutes, not seconds.
  expect(statuses.settledTtl).toBe(600);
  // The stored object is only for the Computer's pull, so it goes once the pull is over.
  await removal.promise;
  expect(removed).toEqual([`workspaces/ws-1/computer-files/pc-1/${uploadId}/original`]);
});

test.each([
  ["a Computer the viewer does not own", { owned: async () => false }, "unavailable"],
  [
    "storage that cannot sign a download",
    { storage: storage({ presignGet: false }) },
    "storage_unavailable",
  ],
  ["an offline Computer", { online: async () => false }, "offline"],
  ["a Computer that cannot pull yet", { supported: async () => false }, "unsupported"],
] as const)(
  "start refuses %s before storing or recording anything",
  async (_name, options, status) => {
    const { uploads, statuses, published, stored } = harness(options);
    expect(await uploads.start(viewer, computerId, hello())).toEqual({ status });
    expect(stored).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(statuses.calls).toEqual([]);
  },
);

test("start refuses a file that is empty, over the limit, or has no usable name", async () => {
  const { uploads, statuses, stored } = harness();
  const sized = (size: number, name = "notes.txt") =>
    ({ name, size, type: "text/plain" }) as unknown as File;
  expect(await uploads.start(viewer, computerId, sized(0))).toEqual({ status: "too_large" });
  expect(await uploads.start(viewer, computerId, sized(COMPUTER_FILE_MAX_BYTES + 1))).toEqual({
    status: "too_large",
  });
  expect(await uploads.start(viewer, computerId, sized(5, "..."))).toEqual({
    status: "invalid_name",
  });
  expect(stored).toHaveLength(0);
  expect(statuses.calls).toEqual([]);
});

test("start throws, with nothing stored, when the record cannot be written", async () => {
  const { uploads, statuses, stored } = harness();
  statuses.failBegin = true;
  await expect(uploads.start(viewer, computerId, hello())).rejects.toThrow("redis is down");
  expect(stored).toHaveLength(0);
});

test("a storage failure ends the upload as failed with its message", async () => {
  const { uploads, statuses, published, removed, removal, start } = harness({
    storage: storage({
      put: async () => {
        throw new Error("bucket is read-only");
      },
    }),
  });
  const uploadId = await start();
  await statuses.settled.promise;
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({
    status: "failed",
    reason: "failed",
    message: "bucket is read-only",
  });
  expect(published).toHaveLength(0);
  // Whatever part of the object landed is removed too.
  await removal.promise;
  expect(removed).toEqual([`workspaces/ws-1/computer-files/pc-1/${uploadId}/original`]);
});

test("a storage put that outlasts its bound ends as a plain failure, with no raw text", async () => {
  const never = deferred();
  const { uploads, statuses, removal, start } = harness({
    storage: storage({ put: () => never.promise }),
    timing: { storeTimeoutMs: 5 },
  });
  try {
    const uploadId = await start();
    await statuses.settled.promise;
    expect(await uploads.read(viewer, computerId, uploadId)).toEqual({
      status: "failed",
      reason: "failed",
    });
    await removal.promise;
  } finally {
    never.resolve();
  }
});

test("a Computer that went offline while the object was stored is not asked to pull", async () => {
  let reachable = true;
  const { uploads, statuses, published, start } = harness({
    online: async () => reachable,
    storage: storage({
      put: async () => {
        reachable = false;
      },
    }),
  });
  const uploadId = await start();
  await statuses.settled.promise;
  expect(published).toHaveLength(0);
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({
    status: "failed",
    reason: "offline",
  });
});

test("the Computer's refusal, a publish failure and a pull that never answers each end as failed", async () => {
  const refused = harness();
  refused.pullResults.answerWhenAsked = (request) =>
    answer(request, { status: "error", path: "", errorMessage: "disk full" });
  const refusedId = await refused.start();
  await refused.statuses.settled.promise;
  expect(await refused.uploads.read(viewer, computerId, refusedId)).toEqual({
    status: "failed",
    reason: "failed",
    message: "disk full",
  });

  const unpublished = harness({
    publishPull: async () => {
      throw new Error("centrifugo is down");
    },
  });
  const unpublishedId = await unpublished.start();
  await unpublished.statuses.settled.promise;
  expect(await unpublished.uploads.read(viewer, computerId, unpublishedId)).toEqual({
    status: "failed",
    reason: "unavailable",
  });
  expect(unpublished.pullResults.cleared).toBe(1);

  const silent = harness({ timing: { pullTimeoutMs: 1_000 } });
  const silentId = await silent.start();
  await silent.statuses.settled.promise;
  expect(await silent.uploads.read(viewer, computerId, silentId)).toEqual({
    status: "failed",
    reason: "timeout",
  });
  await silent.removal.promise;
  expect(silent.removed).toHaveLength(1);
});

test("an object that cannot be removed does not change how the upload ended", async () => {
  const { uploads, statuses, removal, start } = harness({
    storage: storage({
      remove: async () => {
        throw new Error("bucket is down");
      },
    }),
  });
  const uploadId = await start();
  await statuses.settled.promise;
  await removal.promise;
  expect((await uploads.read(viewer, computerId, uploadId)).status).toBe("failed");
});

test("an answer for another file does not place the upload", async () => {
  const waits = new PullWaits();
  const { uploads, statuses, pullResults, published, start } = harness({
    timing: { wait: waits.wait },
  });
  const uploadId = await start();
  await waits.parkedInWait();
  pullResults.result = answer(published[0]!, { fileName: "other.txt" });
  waits.resume();
  await statuses.settled.promise;
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({
    status: "failed",
    reason: "unavailable",
  });
});

test("the buffered body is not held while the Computer pulls", async () => {
  const waits = new PullWaits();
  const { statuses, start } = harness({ timing: { wait: waits.wait } });
  let body: WeakRef<File> | undefined;
  await (async () => {
    const file = hello();
    body = new WeakRef(file);
    await start(file);
  })();
  await waits.parkedInWait();
  for (let round = 0; round < 5; round++) {
    Bun.gc(true);
    await Bun.sleep(1);
  }
  expect(body?.deref()).toBeUndefined();
  waits.resume();
  await statuses.settled.promise;
});
