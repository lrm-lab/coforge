import { expect, test } from "bun:test";
import { harness, request, now } from "./support/host-jobs-harness";

test("a queued shared replacement is retired when its image becomes retained", async () => {
  let policy: "allow" | "retain" = "allow";
  const { hosts, jobs, fleet } = harness({ imageUpdatePolicy: async () => policy });
  const created = await hosts.ensureDefault(request);
  await hosts.report({
    token: "host-token",
    jobId: (await hosts.claim({ token: "host-token" }))!.jobId,
    containerId: "service-1",
    now,
  });
  const update = await hosts.requestImageUpdate({
    ...request,
    computerId: created.computerId,
    imageId: "sha256:new",
  });
  policy = "retain";
  expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
  expect(jobs.records.find((job) => job.id === update.jobId)?.reportedAt).not.toBeNull();
  expect(fleet.computers[0]?.containerReady).toBe(true);
  expect(fleet.computers[0]?.deletedAt).toBeNull();
});

test("an unknown image defers a queued replace until the ordinary image is observed", async () => {
  let policy: "allow" | "unknown" = "allow";
  const { hosts, jobs } = harness({ imageUpdatePolicy: async () => policy });
  const created = await hosts.ensureDefault(request);
  await hosts.report({
    token: "host-token",
    jobId: (await hosts.claim({ token: "host-token" }))!.jobId,
    containerId: "service-1",
    now,
  });
  const update = await hosts.requestImageUpdate({
    ...request,
    computerId: created.computerId,
    imageId: "sha256:new",
  });
  policy = "unknown";
  expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
  expect(jobs.records.find((job) => job.id === update.jobId)?.reportedAt).toBeNull();
  policy = "allow";
  expect(await hosts.claim({ token: "host-token" })).toMatchObject({
    operation: "update",
    jobId: update.jobId,
  });
});
