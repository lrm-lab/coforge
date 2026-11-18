import { afterEach, expect, test } from "bun:test";

import {
  BUCKET,
  CREDENTIALS,
  fixtureConnection,
  startFakeOssServer,
  stopFakeOssServers,
} from "./fixtures/fake-oss";
import { crc64Decimal } from "./oss-crc64";
import { objectDigest, putObject } from "./oss-objects";
import { createOssClient } from "./publish";

afterEach(() => stopFakeOssServers());

const clientFor = async (fake: ReturnType<typeof startFakeOssServer>) =>
  createOssClient(fixtureConnection(fake), CREDENTIALS);

test("a multipart upload reports the whole object's checksum, which HEAD then confirms", async () => {
  const fake = startFakeOssServer();
  const client = await clientFor(fake);
  const bytes = new Uint8Array(2_500_000);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) & 0xff;

  const reported = await putObject(client, "9.9.9/big-object", bytes, { multipartMinBytes: 1 });

  expect(reported).toBe(crc64Decimal(bytes));
  const methods = fake.calls.map((call) => call.method);
  expect(methods).toContain("POST");
  expect(methods.filter((method) => method === "PUT").length).toBeGreaterThan(1);
  expect(await objectDigest(client, "9.9.9/big-object")).toEqual({
    size: bytes.byteLength,
    crc64: crc64Decimal(bytes),
  });
  expect(fake.peek("9.9.9/big-object")).toEqual(bytes);
});

test("a single put reports the same checksum the object reads back", async () => {
  const fake = startFakeOssServer();
  const client = await clientFor(fake);
  const bytes = new TextEncoder().encode(`{"version":"${BUCKET}"}`);

  expect(await putObject(client, "9.9.9/manifest.json", bytes)).toBe(crc64Decimal(bytes));
  expect(await objectDigest(client, "9.9.9/manifest.json")).toEqual({
    size: bytes.byteLength,
    crc64: crc64Decimal(bytes),
  });
});

test("an upload answer that carries no checksum is refused rather than read back", async () => {
  const fake = startFakeOssServer({ omitCrc64Keys: new Set(["9.9.9/silent"]) });
  const client = await clientFor(fake);

  await expect(
    putObject(client, "9.9.9/silent", new TextEncoder().encode("bytes")),
  ).rejects.toThrow(/reported no x-oss-hash-crc64ecma for 9\.9\.9\/silent/);
  expect(fake.calls.filter((call) => call.method === "GET")).toEqual([]);
});

test("the checksum is compared as a decimal string, so a top-bit value keeps all 64 bits", async () => {
  const fake = startFakeOssServer();
  const client = await clientFor(fake);
  const bytes = new TextEncoder().encode("123456789");

  const expected = crc64Decimal(bytes);
  expect(expected).toBe("11051210869376104954");
  expect(await putObject(client, "9.9.9/vector", bytes)).toBe(expected);
  expect((await objectDigest(client, "9.9.9/vector")).crc64).toBe(expected);
});
