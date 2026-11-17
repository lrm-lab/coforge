import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemory } from "#src/local-memory/local-memory";
import { buildStartupMemoryBlock } from "#src/agent-runtime/startup-memory-block";

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

test("bounded list pages discover omitted facts and get returns their complete evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-memory-list-"));
  roots.push(root);
  const memory = new LocalMemory(root);
  const keys = [];
  for (let i = 0; i < 23; i++) {
    const key = `fact-${String(i).padStart(2, "0")}`;
    keys.push(key);
    await memory.execute({
      operation: "save",
      key,
      revision: "new",
      title: key,
      content: `${"Long evidence ".repeat(800)} confirmed end ${i}`,
      source: "user message",
      kind: "fact",
      applicability: "production",
    });
  }
  const found = [];
  let offset = 0;
  for (;;) {
    const result = await memory.execute({ operation: "list", offset });
    expect(result.entries.length).toBeLessThanOrEqual(10);
    expect(result.entries.every((entry) => entry.content.length <= 600)).toBe(true);
    found.push(...result.entries.map((entry) => entry.key));
    if (result.nextOffset === undefined) break;
    expect(result.nextOffset).toBeGreaterThan(offset);
    offset = result.nextOffset;
  }
  expect(found).toEqual(keys);
  const complete = (await memory.execute({ operation: "get", key: "fact-00" })).entries[0]!;
  expect(complete.content).toContain("confirmed end 0");
  await memory.execute({ operation: "archive", key: complete.key, revision: complete.revision });
  expect(
    (await memory.execute({ operation: "list" })).entries.some(
      (entry) => entry.key === complete.key,
    ),
  ).toBe(false);
  expect((await memory.execute({ operation: "list", archived: true })).entries[0]?.key).toBe(
    complete.key,
  );
  const block = await buildStartupMemoryBlock({ agentWorkspaceDirectory: root });
  expect(block?.text).toContain("coforge memory list");
  expect(block?.text).toContain("coforge memory search");
  expect(block?.text).toContain("coforge memory get --key");
  expect(block?.text).toContain("partial");
  expect(Buffer.byteLength(block!.text)).toBeLessThanOrEqual(4_000 * 4 + 500);
});

test("multibyte listing previews fit one response budget and pagination never skips a fact", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-memory-list-budget-"));
  roots.push(root);
  const memory = new LocalMemory(root);
  for (let i = 0; i < 8; i++)
    await memory.execute({
      operation: "save",
      key: `fact-${i}`,
      revision: "new",
      title: "题".repeat(200),
      content: "文".repeat(3_000),
      source: "源".repeat(1_000),
      applicability: "用".repeat(300),
      kind: "decision",
    });
  const seen: string[] = [];
  let offset = 0;
  for (;;) {
    const result = await memory.execute({ operation: "list", offset });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12_000);
    seen.push(...result.entries.map((entry) => entry.key));
    if (result.nextOffset === undefined) break;
    expect(result.nextOffset).toBeGreaterThan(offset);
    offset = result.nextOffset;
  }
  expect(seen).toEqual(Array.from({ length: 8 }, (_, i) => `fact-${i}`));
});

test("a manually edited timestamp cannot stall a listing page and full reads keep the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-memory-list-edited-time-"));
  roots.push(root);
  const memory = new LocalMemory(root);
  await memory.execute({
    operation: "save",
    key: "fact",
    revision: "new",
    title: "Fact",
    content: "Confirmed",
    source: "human",
    applicability: "staging",
    kind: "fact",
  });
  const path = join(root, "notes/knowledge/fact.md");
  const lines = (await Bun.file(path).text()).split("\n");
  const header = JSON.parse(lines[1]!);
  header.updatedAt = "2026-11-17" + " ".repeat(12_000);
  lines[1] = JSON.stringify(header);
  await Bun.write(path, lines.join("\n"));
  const listed = await memory.execute({ operation: "list" });
  expect(listed.entries).toHaveLength(1);
  expect(listed.nextOffset).toBeUndefined();
  expect(listed.entries[0]?.updatedAt).toBe("2026-11-17T00:00:00.000Z");
  expect((await memory.execute({ operation: "get", key: "fact" })).entries[0]?.updatedAt).toBe(
    header.updatedAt,
  );
  header.key = "other";
  lines[1] = JSON.stringify(header);
  await Bun.write(path, lines.join("\n"));
  const mismatched = await memory.execute({ operation: "list" });
  expect(mismatched.entries).toHaveLength(0);
  expect(mismatched.incomplete).toBe(true);
});
