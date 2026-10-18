import { afterEach, expect, test } from "bun:test";
import {
  CREDENTIALS,
  fixtureConnection,
  startFakeOssServer,
  stopFakeOssServers,
} from "./fixtures/fake-oss";
import { createOssClient, DEFAULT_TARGETS } from "./publish";
import { withdrawStagingRelease } from "./withdraw";

afterEach(stopFakeOssServers);
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function published(version: string) {
  const objects: Record<string, string> = {};
  const platforms = Object.fromEntries(
    DEFAULT_TARGETS.map((target) => {
      const bytes = version + target;
      objects[version + "/" + target + "/coforge-computer.gz"] = bytes;
      objects[version + "/" + target + "/coforge-computer.sha256"] = sha(bytes) + "\n";
      return [
        target,
        {
          computer: {
            binary: "coforge-computer",
            size: bytes.length,
            checksum: sha(bytes),
            gzip: { binary: "coforge-computer.gz", size: bytes.length, checksum: sha(bytes) },
          },
        },
      ];
    }),
  );
  const wasm = "wasm-" + version;
  objects[version + "/photon_rs_bg.wasm"] = wasm;
  const manifest = JSON.stringify({
    schema_version: 2,
    version,
    commit: "a".repeat(40),
    buildDate: "2026-10-18T00:00:00Z",
    platforms,
    photonWasm: { file: "photon_rs_bg.wasm", size: wasm.length, checksum: sha(wasm) },
  });
  objects[version + "/manifest.json"] = manifest;
  return { objects, manifestSha256: sha(manifest) };
}

const withdrawn = "0.1.4-dev.1";
const restored = "0.1.3-dev.2";

test("withdrawal restores and verifies latest before deleting only the selected release", async () => {
  const wrong = published(withdrawn),
    previous = published(restored);
  const fake = startFakeOssServer({
    previousLatest: withdrawn + "\n",
    preexistingObjects: { ...wrong.objects, ...previous.objects, "installer/latest": "keep\n" },
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  const result = await withdrawStagingRelease(
    {
      version: withdrawn,
      manifestSha256: wrong.manifestSha256,
      restoreVersion: restored,
      restoreManifestSha256: previous.manifestSha256,
    },
    { client, connection },
  );
  expect(result.deleted).toHaveLength(14);
  expect(new TextDecoder().decode(fake.peek("latest"))).toBe(restored + "\n");
  for (const key of Object.keys(wrong.objects)) expect(fake.peek(key)).toBeUndefined();
  for (const [key, value] of Object.entries(previous.objects))
    expect(new TextDecoder().decode(fake.peek(key))).toBe(value);
  expect(new TextDecoder().decode(fake.peek("installer/latest"))).toBe("keep\n");
  const firstDelete = fake.calls.findIndex((call) => call.method === "DELETE");
  expect(fake.calls.slice(0, firstDelete)).toContainEqual({
    method: "ANONYMOUS_GET",
    key: "latest",
  });
  expect(fake.calls.filter((call) => call.method === "DELETE").at(-1)?.key).toBe(
    withdrawn + "/manifest.json",
  );
});

test("withdrawal rejects either unpinned manifest before any mutation", async () => {
  const wrong = published(withdrawn),
    previous = published(restored);
  for (const bad of ["manifestSha256", "restoreManifestSha256"] as const) {
    const fake = startFakeOssServer({
      previousLatest: withdrawn + "\n",
      preexistingObjects: { ...wrong.objects, ...previous.objects },
    });
    const connection = fixtureConnection(fake);
    const client = await createOssClient(connection, CREDENTIALS);
    await expect(
      withdrawStagingRelease(
        {
          version: withdrawn,
          manifestSha256: wrong.manifestSha256,
          restoreVersion: restored,
          restoreManifestSha256: previous.manifestSha256,
          [bad]: "0".repeat(64),
        },
        { client, connection },
      ),
    ).rejects.toThrow("Manifest SHA-256 mismatch");
    expect(fake.calls.filter((call) => ["PUT", "DELETE"].includes(call.method))).toEqual([]);
  }
});

test("withdrawal refuses an unexpected latest or an invalid selection without writes", async () => {
  const wrong = published(withdrawn),
    previous = published(restored);
  for (const change of [
    { latest: "0.1.3-dev.3\n" },
    { latest: "" },
    { version: "../installer" },
    { restoreVersion: withdrawn },
    { restoreVersion: "0.1.3" },
    { manifestSha256: "invalid" },
  ]) {
    const fake = startFakeOssServer({
      previousLatest: change.latest ?? withdrawn + "\n",
      preexistingObjects: { ...wrong.objects, ...previous.objects },
    });
    const connection = fixtureConnection(fake);
    const client = await createOssClient(connection, CREDENTIALS);
    await expect(
      withdrawStagingRelease(
        {
          version: withdrawn,
          manifestSha256: wrong.manifestSha256,
          restoreVersion: restored,
          restoreManifestSha256: previous.manifestSha256,
          ...change,
        },
        { client, connection },
      ),
    ).rejects.toThrow();
    expect(fake.calls.filter((call) => ["PUT", "DELETE"].includes(call.method))).toEqual([]);
  }
});

test("withdrawal requires matching six-platform manifests and complete verified restore objects", async () => {
  for (const flaw of ["version", "platform", "gzip", "sidecar", "wasm", "missing", "public"]) {
    const wrong = published(withdrawn),
      previous = published(restored);
    const gzip = `${restored}/linux-x64/coforge-computer.gz`;
    const manifestKey = `${restored}/manifest.json`;
    if (flaw === "version" || flaw === "platform") {
      const manifest = JSON.parse(previous.objects[manifestKey]!);
      if (flaw === "version") manifest.version = withdrawn;
      else delete manifest.platforms["linux-x64"];
      previous.objects[manifestKey] = JSON.stringify(manifest);
      previous.manifestSha256 = sha(previous.objects[manifestKey]!);
    } else if (flaw === "gzip") previous.objects[gzip] = "wrong";
    else if (flaw === "sidecar")
      previous.objects[`${restored}/linux-x64/coforge-computer.sha256`] = "wrong";
    else if (flaw === "wasm") previous.objects[`${restored}/photon_rs_bg.wasm`] = "wrong";
    else if (flaw === "missing") delete previous.objects[gzip];
    const fake = startFakeOssServer({
      previousLatest: withdrawn + "\n",
      preexistingObjects: { ...wrong.objects, ...previous.objects },
      publicOriginKeys: new Set(flaw === "public" ? [gzip] : []),
    });
    const connection = fixtureConnection(fake);
    const client = await createOssClient(connection, CREDENTIALS);
    await expect(
      withdrawStagingRelease(
        {
          version: withdrawn,
          manifestSha256: wrong.manifestSha256,
          restoreVersion: restored,
          restoreManifestSha256: previous.manifestSha256,
        },
        { client, connection },
      ),
    ).rejects.toThrow();
    expect(fake.calls.filter((call) => ["PUT", "DELETE"].includes(call.method))).toEqual([]);
  }
});

test("the operator CLI rejects incomplete or unknown arguments before contacting storage", async () => {
  for (const args of [[], ["--bucket", "production"], ["--version", withdrawn]]) {
    const child = Bun.spawn([process.execPath, "scripts/release/withdraw.ts", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("withdrawal failed:");
  }
});

test("a failed pointer readback restores the original selector and deletes nothing", async () => {
  const wrong = published(withdrawn),
    previous = published(restored);
  const fake = startFakeOssServer({
    previousLatest: withdrawn + "\n",
    preexistingObjects: { ...wrong.objects, ...previous.objects },
    tamperReadbackKeys: new Set(["latest"]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  await expect(
    withdrawStagingRelease(
      {
        version: withdrawn,
        manifestSha256: wrong.manifestSha256,
        restoreVersion: restored,
        restoreManifestSha256: previous.manifestSha256,
      },
      { client, connection },
    ),
  ).rejects.toThrow("previous latest restored");
  expect(new TextDecoder().decode(fake.peek("latest"))).toBe(withdrawn + "\n");
  expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
});

test("a partial deletion keeps the manifest for retry and never reactivates the withdrawn version", async () => {
  const wrong = published(withdrawn),
    previous = published(restored);
  const failDeleteKeys = new Set([`${withdrawn}/linux-x64/coforge-computer.sha256`]);
  const fake = startFakeOssServer({
    previousLatest: withdrawn + "\n",
    preexistingObjects: { ...wrong.objects, ...previous.objects },
    failDeleteKeys,
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  const input = {
    version: withdrawn,
    manifestSha256: wrong.manifestSha256,
    restoreVersion: restored,
    restoreManifestSha256: previous.manifestSha256,
  };
  await expect(withdrawStagingRelease(input, { client, connection })).rejects.toThrow(
    "OSS delete failed",
  );
  expect(new TextDecoder().decode(fake.peek("latest"))).toBe(restored + "\n");
  expect(fake.peek(`${withdrawn}/linux-x64/coforge-computer.gz`)).toBeUndefined();
  expect(fake.peek(`${withdrawn}/manifest.json`)).toBeDefined();
  failDeleteKeys.clear();
  expect((await withdrawStagingRelease(input, { client, connection })).deleted).toHaveLength(14);
  expect(fake.peek(`${withdrawn}/manifest.json`)).toBeUndefined();
});

test("a successful DELETE response without actual removal stops before deleting more objects", async () => {
  const wrong = published(withdrawn),
    previous = published(restored);
  const retained = `${withdrawn}/linux-x64/coforge-computer.gz`;
  const fake = startFakeOssServer({
    previousLatest: withdrawn + "\n",
    preexistingObjects: { ...wrong.objects, ...previous.objects },
    retainDeleteKeys: new Set([retained]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  await expect(
    withdrawStagingRelease(
      {
        version: withdrawn,
        manifestSha256: wrong.manifestSha256,
        restoreVersion: restored,
        restoreManifestSha256: previous.manifestSha256,
      },
      { client, connection },
    ),
  ).rejects.toThrow(`Object remains after deletion: ${retained}`);
  expect(new TextDecoder().decode(fake.peek("latest"))).toBe(restored + "\n");
  expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([
    { method: "DELETE", key: retained },
  ]);
  expect(fake.peek(`${withdrawn}/manifest.json`)).toBeDefined();
});
