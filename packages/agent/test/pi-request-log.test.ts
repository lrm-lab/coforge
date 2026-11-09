import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRequestLogWriter, piRequestDigest } from "../src/pi-request-log";

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
  expect(records).toHaveLength(2);
  expect(records[0]?.digest).toBe(piRequestDigest({ messages: ["hello"] }));
  expect(records[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(records[1]?.prevHash).toBe(records[0]?.hash);
  const { hash: _hash, ...withoutHash } = records[1]!;
  expect(records[1]?.hash).toBe(piRequestDigest(withoutHash));
});
