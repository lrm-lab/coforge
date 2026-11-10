import { expect, test } from "bun:test";
import { COMPUTER_FILE_UPLOAD_TIMING } from "#src/server/computers/computer-file-upload.server";
import { COMPUTER_FILE_UPLOAD_CLIENT_DEADLINE_MS } from "#src/features/computers/computer-file-upload-poll";
import {
  SETTLE_ATTEMPTS,
  answer,
  computerId,
  deferred,
  harness,
  PullWaits,
  scope,
  storage,
  viewer,
} from "./helpers/computer-file-upload-harness";

/**
 * The upload's record: its lease while the work runs, how its outcome is written, and who may read
 * it.
 */
test("a running upload renews its record until it ends, and not after", async () => {
  const putGate = deferred();
  const { uploads, statuses, start } = harness({
    storage: storage({ put: () => putGate.promise }),
    timing: { leaseRenewMs: 1 },
  });
  const uploadId = await start();
  await statuses.renewed.promise;
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({ status: "pending" });
  putGate.resolve();
  await statuses.settled.promise;
  // Proving a negative: a renewal landing after the outcome would shorten its lifetime.
  await Bun.sleep(20);
  expect(statuses.calls.filter((call) => call === "renew-after-settle")).toEqual([]);
  expect(statuses.leases.slice(1).every((lease) => lease === 30)).toBe(true);
});

test("a record that expired during a stall is made pending again by the next renewal", async () => {
  const putGate = deferred();
  const { uploads, statuses, start } = harness({
    storage: storage({ put: () => putGate.promise }),
    timing: { leaseRenewMs: 1 },
  });
  const uploadId = await start();
  try {
    await statuses.renewed.promise;
    statuses.expire(scope, uploadId);
    // The upload is alive, so its own renewal brings the record back rather than leaving it failed.
    await statuses.recreated.promise;
    expect(await uploads.read(viewer, computerId, uploadId)).toEqual({ status: "pending" });
  } finally {
    putGate.resolve();
    await statuses.settled.promise;
  }
  // The renewal that follows never overwrites the outcome.
  expect((await uploads.read(viewer, computerId, uploadId)).status).not.toBe("pending");
});

test("an upload whose web process went away expires and reads as failed", async () => {
  const putGate = deferred();
  const { uploads, statuses, start } = harness({
    storage: storage({ put: () => putGate.promise }),
  });
  try {
    const uploadId = await start();
    expect(await uploads.read(viewer, computerId, uploadId)).toEqual({ status: "pending" });
    // The process restarted: nothing renews the record, and the store lets it expire.
    statuses.expire(scope, uploadId);
    expect(await uploads.read(viewer, computerId, uploadId)).toEqual({
      status: "failed",
      reason: "failed",
    });
  } finally {
    putGate.resolve();
    await statuses.settled.promise;
  }
});

test("an outcome whose first write fails is written again, so a success is not lost", async () => {
  const waits: number[] = [];
  const { uploads, statuses, pullResults, start } = harness({
    timing: {
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  });
  pullResults.answerWhenAsked = (request) => answer(request);
  statuses.settleFailures = 1;
  const uploadId = await start();
  await statuses.settled.promise;
  expect(statuses.settleAttempts).toBe(2);
  expect(waits).toContain(1_000);
  expect(await uploads.read(viewer, computerId, uploadId)).toMatchObject({ status: "placed" });
});

test("an outcome that cannot be written after every attempt never escapes the background work", async () => {
  const { statuses, start } = harness();
  statuses.settleFailures = Infinity;
  await start();
  await statuses.settled.promise;
  expect(statuses.settleAttempts).toBe(SETTLE_ATTEMPTS);
});

test("read answers only the Computer's owner who started the upload", async () => {
  const waits = new PullWaits();
  let owner = true;
  let ownerChecks = 0;
  const { uploads, statuses, pullResults, published, start } = harness({
    owned: async () => {
      ownerChecks += 1;
      return owner;
    },
    timing: { wait: waits.wait },
  });
  const uploadId = await start();
  await waits.parkedInWait();

  // A pending upload is answered from its record alone, with no database read.
  ownerChecks = 0;
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({ status: "pending" });
  expect(ownerChecks).toBe(0);

  pullResults.result = answer(published[0]!);
  waits.resume();
  await statuses.settled.promise;

  const others = { userId: "user-2", workspaceId: "ws-1" };
  expect(await uploads.read(others, computerId, uploadId)).toEqual({
    status: "failed",
    reason: "failed",
  });
  expect(await uploads.read({ ...viewer, workspaceId: "ws-2" }, computerId, uploadId)).toEqual({
    status: "failed",
    reason: "failed",
  });
  expect(await uploads.read(viewer, "pc-2", uploadId)).toEqual({
    status: "failed",
    reason: "failed",
  });
  expect(await uploads.read(viewer, computerId, crypto.randomUUID())).toEqual({
    status: "failed",
    reason: "failed",
  });

  // An outcome is shown only to someone who still owns the Computer.
  expect(await uploads.read(viewer, computerId, uploadId)).toMatchObject({ status: "placed" });
  owner = false;
  expect(await uploads.read(viewer, computerId, uploadId)).toEqual({
    status: "failed",
    reason: "unavailable",
  });
});

test("the lifetimes keep the server's verdict the one the page shows", () => {
  const t = COMPUTER_FILE_UPLOAD_TIMING;
  // The page waits past the longest the server may take, so it reads the server's own timeout.
  expect(COMPUTER_FILE_UPLOAD_CLIENT_DEADLINE_MS).toBeGreaterThan(
    t.storeTimeoutMs + t.pullTimeoutMs,
  );
  // A pending record outlives a Redis stall of several renewals, and the signed link outlives
  // the pull.
  expect(t.leaseSeconds).toBeGreaterThanOrEqual(60);
  expect(t.leaseRenewMs * 4).toBeLessThanOrEqual(t.leaseSeconds * 1000);
  expect(t.pullExpiresInSeconds * 1000).toBeGreaterThan(t.pullTimeoutMs);
  // The outcome waits minutes for a page polling from a throttled background tab.
  expect(t.settledSeconds).toBeGreaterThanOrEqual(300);
  // Retrying the outcome's write takes a small part of that.
  expect(t.settleAttempts * t.settleRetryMs * 10).toBeLessThanOrEqual(t.settledSeconds * 1000);
});
