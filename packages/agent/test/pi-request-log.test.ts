import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRequestLogWriter, piContextRequestDigest, piRequestDigest } from "../src/pi-request-log";

test("Pi request logs carry a resumable hash chain and request digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-log-"));
  const path = join(root, "pi-requests.jsonl");
  const writer = new PiRequestLogWriter(path);
  await writer.append({ type: "request", body: { messages: ["hello"] } });
  await writer.append({ type: "response", body: "world" });
  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const indexed = records.find((record) => record.type === "request" && record.shapeHash);
  const blob = records.find((record) => record.type === "blob");
  expect(indexed).toBeDefined();
  expect(blob?.hash).toBe(piRequestDigest("hello"));
  expect(indexed?.digest).toBe(
    piContextRequestDigest(String(indexed?.shapeHash), JSON.stringify(indexed?.params ?? {}), [
      String(blob?.hash),
    ]),
  );
  const legacy = records.find((record) => record.type === "request" && record.body);
  const response = records.find((record) => record.type === "response");
  expect(legacy?.digest).toBe(piRequestDigest({ messages: ["hello"] }));
  expect(response?.prevHash).toBe(legacy?.hash);
  const { hash: _hash, ...withoutHash } = response!;
  expect(response?.hash).toBe(piRequestDigest(withoutHash));
});

test("Pi indexed requests carry a base chain with a trimmed tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-log-chain-"));
  const path = join(root, "pi-requests.jsonl");
  const writer = new PiRequestLogWriter(path);
  await writer.append({ type: "request", body: { messages: ["hello"] } });
  await writer.append({ type: "request", body: { messages: ["hello", "world"] } });
  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const indexed = records.filter((record) => record.type === "request" && record.shapeHash);
  expect(indexed).toHaveLength(2);
  expect(indexed[1]?.base).toBe(indexed[0]?.id);
  expect(indexed[1]?.keep).toBe(1);
  expect(indexed[1]?.tail).toHaveLength(1);
});

test("Pi request logs reject a symlinked parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-log-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "coforge-pi-log-outside-"));
  const linked = join(root, "linked");
  await symlink(outside, linked);
  const writer = new PiRequestLogWriter(join(linked, "session.jsonl"));
  await writer.append({ type: "request", body: { messages: ["secret"] } });
  expect(await lstat(join(outside, "session.jsonl")).catch(() => undefined)).toBeUndefined();
});
