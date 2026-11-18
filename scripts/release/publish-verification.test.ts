import { afterEach, expect, test } from "bun:test";

import {
  CREDENTIALS,
  fixtureConnection,
  startFakeOssServer,
  stopFakeOssServers,
} from "./fixtures/fake-oss";
import { fixtureTree, removeTemporaryDirectories, tempDir } from "./fixtures/publish-fixtures";
import { createOssClient, LATEST_OBJECT_KEY, uploadReleaseTree } from "./publish";

afterEach(async () => {
  stopFakeOssServers();
  await removeTemporaryDirectories();
});

test("an object whose upload or HEAD reports no checksum fails the publish instead of reading it back", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-no-crc", outputDirectory);
  const silentKey = tree.files.find((file) => file.endsWith("manifest.json"));
  if (!silentKey) throw new Error("fixture tree has no manifest.json");
  const fake = startFakeOssServer({ omitCrc64Keys: new Set([silentKey]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /reported no x-oss-hash-crc64ecma for .*manifest\.json/,
  );
  expect(fake.calls.some((call) => call.method === "PUT" && call.key === LATEST_OBJECT_KEY)).toBe(
    false,
  );
  expect(
    fake.calls.filter((call) => call.method === "GET" && call.key !== LATEST_OBJECT_KEY),
  ).toEqual([]);
});

test("an upload answer whose checksum is not the compiled bytes' fails before verification", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-lying-upload", outputDirectory);
  const lyingKey = tree.files[0]!;
  const fake = startFakeOssServer({ lieAboutStoredCrcKeys: new Set([lyingKey]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /OSS stored .* as crc64=1, the uploaded bytes are crc64=/,
  );
});

test("a finalize pass checks the objects already up by HEAD and never reads them back", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-finalize-heads", outputDirectory);
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  await uploadReleaseTree(outputDirectory, tree, { client, connection });
  const before = fake.calls.length;
  const log: string[] = [];

  await uploadReleaseTree(outputDirectory, tree, {
    client,
    connection,
    allowExisting: true,
    activate: false,
    log: (line) => log.push(line),
  });

  const calls = fake.calls.slice(before);
  expect(calls.filter((call) => call.method === "GET")).toEqual([]);
  const objectsOnly = tree.files.filter((file) => !file.endsWith("manifest.json"));
  for (const key of objectsOnly) expect(calls).toContainEqual({ method: "HEAD", key });
  expect(log.filter((line) => line.startsWith("already present, verified "))).toHaveLength(
    objectsOnly.length,
  );
  for (const line of log.filter((entry) => entry.includes("crc64=")))
    expect(line).toMatch(/crc64=\d+ size=\d+$/);
});
