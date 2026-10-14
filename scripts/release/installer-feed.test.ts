import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  assertInstallerCoversRelease,
  installerVersionFromCargoToml,
  productInstallerProtocol,
} from "./installer-feed";

const text = (value: string) => new TextEncoder().encode(value);

/** A feed held in memory: the gate reads it only through `readObject`, so no network is involved. */
function feedOf(objects: Record<string, string | undefined>) {
  const reads: string[] = [];
  return {
    reads,
    readObject: async (key: string) => {
      reads.push(key);
      const value = objects[key];
      return value === undefined ? undefined : text(value);
    },
  };
}

/** What the installer's own manifest says of a version; only the protocol matters to the gate. */
function installerManifest(version: string, installerProtocol: number): string {
  return JSON.stringify({
    schema_version: 1,
    version,
    commit: "a".repeat(40),
    buildDate: "2026-09-30T00:00:00.000Z",
    installer_protocol: installerProtocol,
    platforms: {},
  });
}

const RELEASE = "0.1.1-dev.9";

test("a release that declares no installer protocol needs no installer, and the feed is not read", async () => {
  const feed = feedOf({});

  const line = await assertInstallerCoversRelease({
    releaseVersion: RELEASE,
    requiredProtocol: undefined,
    readObject: feed.readObject,
  });

  expect(line).toContain(RELEASE);
  expect(line).toContain("no installer_protocol");
  // An unreachable or empty installer feed must never block a release that does not use it.
  expect(feed.reads).toEqual([]);
});

for (const [required, provided] of [
  [1, 1],
  [1, 2],
  [2, 2],
] as const) {
  test(`a release that needs installer protocol ${required} passes when installer/latest speaks ${provided}`, async () => {
    const feed = feedOf({
      "installer/latest": "0.3.0\n",
      "installer/0.3.0/manifest.json": installerManifest("0.3.0", provided),
    });

    const line = await assertInstallerCoversRelease({
      releaseVersion: RELEASE,
      requiredProtocol: required,
      readObject: feed.readObject,
    });

    expect(line).toContain(`protocol ${required}`);
    expect(line).toContain("0.3.0");
    expect(feed.reads).toEqual(["installer/latest", "installer/0.3.0/manifest.json"]);
  });
}

test("a release that needs a newer protocol than installer/latest speaks is refused, with both fixes named", async () => {
  const feed = feedOf({
    "installer/latest": "0.3.0\n",
    "installer/0.3.0/manifest.json": installerManifest("0.3.0", 1),
  });

  const refusal = await assertInstallerCoversRelease({
    releaseVersion: RELEASE,
    requiredProtocol: 2,
    readObject: feed.readObject,
  }).catch((error: unknown) => error as Error);

  expect(refusal).toBeInstanceOf(Error);
  const message = (refusal as Error).message;
  expect(message).toContain(RELEASE);
  expect(message).toContain("installer protocol 2");
  expect(message).toContain("installer/latest (0.3.0) speaks protocol 1");
  // Publish an installer that speaks it, or - when one is already up - point at it.
  expect(message).toContain("gh workflow run release-installer-staging.yml --repo lrm-lab/coforge");
  expect(message).toContain("-f pointer_only=<installer version>");
});

test("a release that needs an installer is refused while no installer has been published", async () => {
  const feed = feedOf({});

  await expect(
    assertInstallerCoversRelease({
      releaseVersion: RELEASE,
      requiredProtocol: 1,
      readObject: feed.readObject,
    }),
  ).rejects.toThrow(/no installer is published.*gh workflow run release-installer-staging\.yml/s);
});

test("a pointer that names a version with no readable manifest is a broken feed, not a pass", async () => {
  for (const objects of [
    { "installer/latest": "0.3.0\n" },
    { "installer/latest": "0.3.0\n", "installer/0.3.0/manifest.json": "not json" },
    {
      "installer/latest": "0.3.0\n",
      "installer/0.3.0/manifest.json": installerManifest("0.2.0", 5),
    },
    { "installer/latest": "../etc\n" },
    { "installer/latest": "\n" },
  ]) {
    await expect(
      assertInstallerCoversRelease({
        releaseVersion: RELEASE,
        requiredProtocol: 1,
        readObject: feedOf(objects).readObject,
      }),
    ).rejects.toThrow(/installer\/latest.*pointer_only=<installer version>/s);
  }
});

test("a product manifest's installer_protocol is a positive integer, absent, or an error", () => {
  const manifest = (fields: object) => text(JSON.stringify({ schema_version: 2, ...fields }));

  expect(productInstallerProtocol(manifest({}))).toBeUndefined();
  expect(productInstallerProtocol(manifest({ installer_protocol: 3 }))).toBe(3);
  for (const installer_protocol of [0, -1, 1.5, "1", null, true]) {
    expect(() => productInstallerProtocol(manifest({ installer_protocol }))).toThrow(
      /installer_protocol/,
    );
  }
  expect(() => productInstallerProtocol(text("not json"))).toThrow(/manifest/);
});

test("the installer version is the crate's, and nothing else is accepted as one", async () => {
  const cargoToml = await readFile(
    new URL("../../crates/installer/Cargo.toml", import.meta.url),
    "utf8",
  );
  expect(installerVersionFromCargoToml(cargoToml)).toMatch(/^\d+\.\d+\.\d+/);

  expect(installerVersionFromCargoToml('[package]\nname = "x"\nversion = "1.2.3-rc.1"\n')).toBe(
    "1.2.3-rc.1",
  );
  for (const bad of [
    '[package]\nname = "x"\n',
    '[package]\nversion = "1.0/../x"\n',
    '[package]\nversion = "-1.0.0"\n',
    "[package]\nversion = { workspace = true }\n",
    "[workspace]\nmembers = []\n",
  ]) {
    expect(() => installerVersionFromCargoToml(bad)).toThrow(/version to publish/);
  }
});
