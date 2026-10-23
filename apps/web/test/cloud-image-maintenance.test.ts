import { expect, test } from "bun:test";
import * as inventoryConfig from "#src/server/hosts/cloud-image-inventory.server";
const { CloudImageInventory } = inventoryConfig;
import { validateStartupConfig } from "#src/server/startup-config.server";
import { harness, request, now } from "./support/host-jobs-harness";

const snapshot = {
  image: { id: "sha256:new", version: "next" },
  computers: [{ computerId: "one", imageId: "sha256:private" }],
};

test("maintenance blocks updates even when inventory is unavailable", async () => {
  const inventory = new CloudImageInventory(
    {
      get: async () => {
        throw new Error("offline");
      },
      set: async () => {},
    },
    new Set(),
    true,
  );
  expect(await inventory.replacementPolicy("one")).toBe("paused");
  expect(await inventory.available("one")).toBeUndefined();
});

test("maintenance hides replacement while preserving each real image identity", async () => {
  const inventory = new CloudImageInventory(
    { get: async () => JSON.stringify(snapshot), set: async () => {} },
    new Set(),
    true,
  );
  expect((await inventory.snapshot())?.computers[0]).toEqual({
    ...snapshot.computers[0],
    retained: true,
  });
  expect((await inventory.images(["one"])).get("one")?.update).toBeUndefined();
});

test("maintenance flag is explicit and invalid deployment configuration fails at boot", async () => {
  for (const value of [undefined, "", "false"])
    expect(inventoryConfig.readCloudImageUpdatesPaused(value)).toBe(false);
  expect(inventoryConfig.readCloudImageUpdatesPaused("true")).toBe(true);
  expect(() => inventoryConfig.readCloudImageUpdatesPaused("yes")).toThrow();
  await expect(
    validateStartupConfig({ COFORGE_CLOUD_IMAGE_UPDATES_PAUSED: "yes" }),
  ).rejects.toThrow("COFORGE_CLOUD_IMAGE_UPDATES_PAUSED");
});

test("maintenance defers a queued update without marking it reported and permits later recovery", async () => {
  let policy: "allow" | "paused" = "allow";
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
  policy = "paused";
  expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
  expect(jobs.records.find((job) => job.id === update.jobId)?.reportedAt).toBeNull();
  await expect(
    hosts.requestImageUpdate({
      ...request,
      computerId: created.computerId,
      imageId: "sha256:other",
    }),
  ).rejects.toThrow("cloud-image-update-refused");
  policy = "allow";
  expect(await hosts.claim({ token: "host-token" })).toMatchObject({
    jobId: update.jobId,
    operation: "update",
  });
});

test("paused updates do not prevent unrelated creation from being claimed", async () => {
  let paused = false;
  const { hosts, jobs } = harness({
    imageUpdatesPaused: () => paused,
    imageUpdatePolicy: async () => (paused ? "paused" : "allow"),
  });
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
  const copy = {
    ...jobs.records.find((job) => job.id === update.jobId)!,
    id: "unrelated-create",
    operation: "create" as const,
    daemonApiKey: "dk_fixture",
    createdAt: new Date(now.getTime() + 1),
  };
  jobs.records.push(copy);
  paused = true;
  expect(await hosts.claim({ token: "host-token" })).toMatchObject({
    jobId: copy.id,
    operation: "create",
  });
  expect(jobs.records.find((job) => job.id === update.jobId)?.reportedAt).toBeNull();
});
