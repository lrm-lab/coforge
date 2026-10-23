import { describe, expect, test } from "bun:test";

import {
  CloudImageInventory,
  cloudImageUpdateFor,
  parseHostImageReport,
  readRetainedCloudImageIds,
} from "#src/server/hosts/cloud-image-inventory.server";
import {
  cloudComputerImage,
  cloudImageUpdateAvailable,
  cloudImageUpdateConsequences,
} from "#src/features/computers/cloud-image-update";

describe("host image report", () => {
  test("a heartbeat without an image leaves the inventory unchanged", () => {
    expect(parseHostImageReport({ accepting: true })).toBeUndefined();
  });

  test("a well-formed image report names the node image and each running computer", () => {
    expect(
      parseHostImageReport({
        accepting: true,
        image: { id: "sha256:new", version: "0.1.3-dev.2" },
        computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
      }),
    ).toEqual({
      image: { id: "sha256:new", version: "0.1.3-dev.2" },
      computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
    });
  });

  test("a heartbeat with an image id and no runtime version is still a snapshot", () => {
    expect(
      parseHostImageReport({
        accepting: true,
        image: { id: "sha256:new" },
        computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
      }),
    ).toEqual({
      image: { id: "sha256:new", version: "" },
      computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
    });
  });
});

describe("cloud image update availability", () => {
  const snapshot = {
    image: { id: "sha256:new", version: "0.1.3-dev.2" },
    computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
  };

  test("a running computer whose image id differs from the node image can be updated", () => {
    expect(cloudImageUpdateFor(snapshot, "computer-1")).toEqual({
      imageId: "sha256:new",
      version: "0.1.3-dev.2",
    });
    expect(cloudImageUpdateAvailable("sha256:old", "sha256:new")).toBe(true);
  });

  test("the same runtime version on a different image layer is still an update", () => {
    const rebuilt = {
      image: { id: "sha256:new", version: "0.1.7-dev.8" },
      computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
    };
    expect(cloudImageUpdateFor(rebuilt, "computer-1")).toEqual({
      imageId: "sha256:new",
      version: "0.1.7-dev.8",
    });
  });

  test("a tagged digest and a raw image id that name the same layer are not an update", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    expect(
      cloudImageUpdateFor(
        {
          image: { id: digest, version: "0.1.7-dev.8" },
          computers: [
            {
              computerId: "computer-1",
              imageId: `coforge-computer:staging@${digest}`,
            },
          ],
        },
        "computer-1",
      ),
    ).toBeUndefined();
  });

  test("without a runtime version the offer names the node image id", () => {
    expect(
      cloudImageUpdateFor(
        {
          image: { id: "sha256:newlayer", version: "" },
          computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
        },
        "computer-1",
      ),
    ).toEqual({
      imageId: "sha256:newlayer",
      version: "sha256:newlayer",
    });
    const digest = `sha256:${"ef".repeat(32)}`;
    expect(
      cloudImageUpdateFor(
        {
          image: { id: digest, version: "" },
          computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
        },
        "computer-1",
      ),
    ).toEqual({
      imageId: digest,
      version: "efefefefefef",
    });
  });

  test("the image row names the running layer, and an update only when it differs", () => {
    expect(cloudComputerImage(snapshot, "computer-1")).toEqual({
      version: "sha256:old",
      update: { imageId: "sha256:new", version: "0.1.3-dev.2" },
    });
    expect(
      cloudComputerImage(
        {
          image: { id: "sha256:new", version: "0.1.3-dev.2" },
          computers: [{ computerId: "computer-1", imageId: "sha256:new" }],
        },
        "computer-1",
      ),
    ).toEqual({ version: "0.1.3-dev.2" });
    expect(cloudComputerImage(snapshot, "missing")).toBeUndefined();
  });

  test("a computer already on the node image is not offered an update", () => {
    expect(
      cloudImageUpdateFor(
        {
          image: { id: "sha256:new", version: "0.1.3-dev.2" },
          computers: [{ computerId: "computer-1", imageId: "sha256:new" }],
        },
        "computer-1",
      ),
    ).toBeUndefined();
    expect(cloudImageUpdateAvailable("sha256:new", "sha256:new")).toBe(false);
  });

  test("the replace keeps the volume and reconnects agents after a brief disconnect", () => {
    expect(cloudImageUpdateConsequences.lost).toEqual([
      "in_flight_runs",
      "volatile_memory",
      "brief_disconnect",
    ]);
    expect(cloudImageUpdateConsequences.kept).toEqual([
      "volume_files",
      "workspace_bindings",
      "agents_after_reconnect",
    ]);
  });
});

describe("cloud image inventory", () => {
  test("replace then available returns the newer node image for an outdated computer", async () => {
    const values = new Map<string, string>();
    const inventory = new CloudImageInventory({
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
        return "OK";
      },
    });
    await inventory.replace({
      image: { id: "sha256:new", version: "0.1.3-dev.2" },
      computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
    });
    expect(await inventory.available("computer-1")).toEqual({
      imageId: "sha256:new",
      version: "0.1.3-dev.2",
    });
    expect(await inventory.available("computer-2")).toBeUndefined();
  });
});

test("retained image protection survives heartbeat refresh and blocks server offers", async () => {
  const values = new Map<string, string>();
  const retained = `sha256:${"ab".repeat(32)}`;
  const inventory = new CloudImageInventory(
    {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
        return "OK";
      },
    },
    new Set([retained]),
  );
  const report = {
    image: { id: "sha256:shared", version: "0.1.8-dev.4" },
    computers: [
      { computerId: "preserved", imageId: `coforge-computer:private@${retained}` },
      { computerId: "ordinary", imageId: "sha256:ordinary" },
    ],
  };
  for (let refresh = 0; refresh < 2; refresh++) {
    await inventory.replace(report);
    expect(await inventory.available("preserved")).toBeUndefined();
    expect(await inventory.replacementPolicy("preserved")).toBe("retain");
    expect(await inventory.replacementPolicy("missing")).toBe("unknown");
    expect(await inventory.replacementPolicy("ordinary")).toBe("allow");
    const images = await inventory.images(["preserved", "ordinary"]);
    expect(images.get("preserved")).toEqual({ version: "abababababab" });
    expect(images.get("ordinary")?.update?.version).toBe("0.1.8-dev.4");
    expect((await inventory.snapshot())?.computers[0]?.imageId).toBe(report.computers[0]!.imageId);
  }
});

test("retained deployment configuration accepts exact image identities and rejects typos", () => {
  const id = `sha256:${"ab".repeat(32)}`;
  expect(readRetainedCloudImageIds(undefined).size).toBe(0);
  expect([...readRetainedCloudImageIds(`${id}, ${id}`)]).toEqual([id]);
  expect(() => readRetainedCloudImageIds("coforge-computer:staging")).toThrow(
    "COFORGE_RETAINED_CLOUD_IMAGE_IDS",
  );
});
