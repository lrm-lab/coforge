import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildReleaseTree } from "./build-release";
import type { ReleaseTarget } from "./compile-targets";
import {
  BUCKET,
  CREDENTIALS,
  REGION,
  startFakeOssServer,
  stopFakeOssServers,
} from "./fixtures/fake-oss";
import {
  TEST_TARGETS,
  removeTemporaryDirectories,
  stubCompile,
  stubResolvePhotonWasm,
} from "./fixtures/publish-fixtures";
import {
  LATEST_OBJECT_KEY,
  manifestObjectKey,
  runPublish,
  type PublishDependencies,
  type PublishOptions,
} from "./publish";

afterEach(async () => {
  stopFakeOssServers();
  await removeTemporaryDirectories();
});

/* ------------------------------------------------------------------------------------------- */
/* 6. The installer gate: a release cannot outrun the installer that installs it                */
/* ------------------------------------------------------------------------------------------- */

/** An installer manifest as `installer/<version>/manifest.json` holds it; the gate reads only its
 * version and protocol. */
function installerManifestJson(version: string, installerProtocol: number): string {
  return JSON.stringify({
    schema_version: 1,
    version,
    commit: "a".repeat(40),
    buildDate: "2026-09-30T00:00:00.000Z",
    installer_protocol: installerProtocol,
    platforms: {},
  });
}

/** Builds the release tree, then has its manifest say what a release that needs an installer would:
 * `build-release.ts` does not write `installer_protocol` yet, so this is the only way to exercise
 * the gate end to end. */
function buildTreeRequiring(installerProtocol: number): PublishDependencies["buildTree"] {
  return async (inputs, directory) => {
    const tree = await buildReleaseTree(inputs, directory);
    const path = join(directory, manifestObjectKey(tree.version));
    const manifest = JSON.parse(await readFile(path, "utf8")) as object;
    await writeFile(
      path,
      `${JSON.stringify({ ...manifest, installer_protocol: installerProtocol }, null, 2)}\n`,
    );
    return tree;
  };
}

async function publishGated(
  fake: ReturnType<typeof startFakeOssServer>,
  deps: Partial<PublishDependencies> = {},
  options: Partial<PublishOptions> = {},
) {
  const logs: string[] = [];
  const outcome = await runPublish(
    {
      version: "9.9.9-gate",
      commit: "a".repeat(40),
      feedUrl: "https://releases-test.coforge.cn",
      targets: TEST_TARGETS as ReleaseTarget[],
      bucket: BUCKET,
      endpoint: fake.baseUrl,
      region: REGION,
      dryRun: false,
      ...options,
    },
    {
      compile: stubCompile(),
      resolvePhotonWasm: stubResolvePhotonWasm(),
      credentials: CREDENTIALS,
      connection: { endpoint: fake.baseUrl, cname: true, secure: false },
      log: (line) => logs.push(line),
      ...deps,
    },
  );
  return { outcome, logs };
}

const installerReads = (fake: ReturnType<typeof startFakeOssServer>) =>
  fake.calls.filter((call) => call.key.startsWith("installer/"));

test("a release that needs a newer installer protocol than installer/latest speaks is refused before any object is uploaded", async () => {
  const fake = startFakeOssServer({
    previousLatest: "9.9.8\n",
    preexistingObjects: {
      "installer/latest": "0.3.0\n",
      "installer/0.3.0/manifest.json": installerManifestJson("0.3.0", 1),
    },
  });

  await expect(publishGated(fake, { buildTree: buildTreeRequiring(2) })).rejects.toThrow(
    /9\.9\.9-gate needs installer protocol 2.*pointer_only=<installer version>/s,
  );

  // Nothing was written, so the version is not burnt: it can be published again once an installer
  // speaks protocol 2, and the product pointer never moved.
  expect(fake.calls).toEqual([
    { method: "GET", key: "installer/latest" },
    { method: "GET", key: "installer/0.3.0/manifest.json" },
  ]);
  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("9.9.8\n");
});

test("a release the installer covers is published and its pointer moves", async () => {
  const fake = startFakeOssServer({
    preexistingObjects: {
      "installer/latest": "0.3.0\n",
      "installer/0.3.0/manifest.json": installerManifestJson("0.3.0", 2),
    },
  });

  const { outcome, logs } = await publishGated(fake, { buildTree: buildTreeRequiring(2) });

  expect(outcome.version).toBe("9.9.9-gate");
  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("9.9.9-gate\n");
  expect(logs.some((line) => line.startsWith("installer gate:") && line.includes("0.3.0"))).toBe(
    true,
  );
});

test("a release that needs an installer is refused while the installer feed is empty", async () => {
  const fake = startFakeOssServer();

  await expect(publishGated(fake, { buildTree: buildTreeRequiring(1) })).rejects.toThrow(
    /no installer is published/,
  );

  expect(fake.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("a release that declares no installer protocol is published without reading the installer feed", async () => {
  const fake = startFakeOssServer();

  const { logs } = await publishGated(fake);

  // Today's releases: build-release.ts writes no installer_protocol, and nothing may block them.
  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("9.9.9-gate\n");
  expect(installerReads(fake)).toEqual([]);
  expect(logs).toContain(
    "installer gate: release 9.9.9-gate declares no installer_protocol, so no installer is required",
  );
});

test("a publication that leaves latest alone does not consult the installer feed", async () => {
  const fake = startFakeOssServer();

  await publishGated(fake, { buildTree: buildTreeRequiring(9) }, { activate: false });

  // The gate guards the move of `latest`; a per-platform job never makes it.
  expect(installerReads(fake)).toEqual([]);
  expect(fake.peek(LATEST_OBJECT_KEY)).toBeUndefined();
});
