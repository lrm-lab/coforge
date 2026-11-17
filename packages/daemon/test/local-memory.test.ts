import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemory } from "#src/local-memory/local-memory";
import { buildStartupMemoryBlock } from "#src/agent-runtime/startup-memory-block";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function subject() {
  const root = await mkdtemp(join(tmpdir(), "coforge-local-memory-"));
  roots.push(root);
  return { root, memory: new LocalMemory(root) };
}

const purchased = {
  operation: "save" as const,
  key: "preview-domain",
  revision: "new",
  title: "预览域名",
  content: "coforgeusercontent.com 已于 11 月 2 日购买，ICP 备案办理中。",
  source: "用户消息：11 月 5 日确认",
  kind: "decision" as const,
  applicability: "CoForge artifact preview",
};

test("a saved decision survives a new store, is searchable in Chinese, and keeps its evidence", async () => {
  const { root, memory } = await subject();
  const saved = await memory.execute(purchased);
  expect(saved.entries[0]?.source).toBe(purchased.source);
  const restarted = new LocalMemory(root);
  const found = await restarted.execute({ operation: "search", query: "预览 域名 买过" });
  expect(found.entries[0]?.content).toContain("coforgeusercontent.com");
  expect(found.entries[0]?.applicability).toBe(purchased.applicability);
  expect(await readFile(join(root, "notes/knowledge/preview-domain.md"), "utf8")).toContain(
    purchased.content,
  );
});

test("a verified correction replaces the current fact, preserves history and refuses stale writes", async () => {
  const { memory } = await subject();
  const first = (await memory.execute(purchased)).entries[0]!;
  const second = (
    await memory.execute({
      ...purchased,
      revision: first.revision,
      content: "备案已完成。",
      source: "用户最新确认",
    })
  ).entries[0]!;
  expect(second.revision).not.toBe(first.revision);
  await expect(memory.execute({ ...purchased, revision: first.revision })).rejects.toThrow(
    "memory_conflict",
  );
  const history = await memory.execute({ operation: "history", key: purchased.key });
  expect(history.entries.some((entry) => entry.content === purchased.content)).toBe(true);
  expect((await memory.execute({ operation: "get", key: purchased.key })).entries[0]?.content).toBe(
    "备案已完成。",
  );
});

test("simultaneous updates cannot both replace the same version", async () => {
  const { memory } = await subject();
  const first = (await memory.execute(purchased)).entries[0]!;
  const results = await Promise.allSettled([
    memory.execute({ ...purchased, revision: first.revision, content: "a" }),
    memory.execute({ ...purchased, revision: first.revision, content: "b" }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});

test("search sees manual edits and long legacy notes without loading code or history", async () => {
  const { root, memory } = await subject();
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "MEMORY.md"), "# Memory\n- Purple only on primary buttons.");
  await writeFile(
    join(root, "notes/old-log.md"),
    `${"irrelevant\n".repeat(18_000)}Already purchased: coforgeusercontent.com`,
  );
  expect(
    (await memory.execute({ operation: "search", query: "coforgeusercontent.com" })).entries[0]
      ?.content,
  ).toContain("Already purchased");
  await writeFile(join(root, "MEMORY.md"), "# Memory\n- Blue only on primary buttons.");
  expect(
    (await memory.execute({ operation: "search", query: "Blue" })).entries[0]?.content,
  ).toContain("Blue");
});

test("archived facts leave recall and ordinary startup summaries, and remain inspectable", async () => {
  const { memory } = await subject();
  const first = (await memory.execute(purchased)).entries[0]!;
  await memory.execute({ operation: "archive", key: first.key, revision: first.revision });
  expect(
    (await memory.execute({ operation: "search", query: "coforgeusercontent.com" })).entries,
  ).toHaveLength(0);
  expect(await memory.brief(2_000)).toBe("");
  expect((await memory.execute({ operation: "get", key: first.key })).entries[0]?.status).toBe(
    "archived",
  );
});

test("a manual edit changes the compare-and-set token", async () => {
  const { root, memory } = await subject();
  const first = (await memory.execute(purchased)).entries[0]!;
  const path = join(root, "notes/knowledge/preview-domain.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("备案办理中", "备案已完成"));
  await expect(memory.execute({ ...purchased, revision: first.revision })).rejects.toThrow(
    "memory_conflict",
  );
});

test("traversal and symlinked notes cannot read or write another workspace", async () => {
  const { root, memory } = await subject();
  const other = await subject();
  await writeFile(join(other.root, "secret.md"), "private-neighbour");
  await symlink(other.root, join(root, "notes"));
  await expect(memory.execute(purchased)).rejects.toThrow();
  expect(
    (await memory.execute({ operation: "search", query: "private-neighbour" })).entries,
  ).toHaveLength(0);
  await expect(memory.execute({ operation: "get", key: "../../secret" })).rejects.toThrow();
});

test("an unrelated unreadable summary candidate does not hide healthy saved decisions", async () => {
  const { root, memory } = await subject();
  await memory.execute(purchased);
  await writeFile(join(root, "notes/knowledge/bad.md"), "x".repeat(512 * 1024 + 1));
  expect((await buildStartupMemoryBlock({ agentWorkspaceDirectory: root }))?.text).toContain(
    "coforgeusercontent.com",
  );
});

test("decision priority applies beyond the first 128 alphabetical files", async () => {
  const { memory } = await subject();
  for (let index = 0; index < 128; index++)
    await memory.execute({
      ...purchased,
      key: `fact-${String(index).padStart(3, "0")}`,
      kind: "fact",
      title: "Routine fact",
      content: `Routine ${index}`,
    });
  await memory.execute(purchased);
  expect(await memory.brief(3_200)).toContain("coforgeusercontent.com");
});

test("independent memory clients cannot overwrite the same revision", async () => {
  const { root, memory } = await subject();
  const first = (await memory.execute(purchased)).entries[0]!;
  const other = new LocalMemory(root);
  const outcomes = await Promise.allSettled([
    memory.execute({ ...purchased, revision: first.revision, content: "First correction" }),
    other.execute({ ...purchased, revision: first.revision, content: "Second correction" }),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
});

test("history previews can be paged and one historical revision is read completely", async () => {
  const { memory } = await subject();
  let current = (await memory.execute({ ...purchased, content: "历史依据".repeat(1000) }))
    .entries[0]!;
  const original = current;
  for (let index = 0; index < 7; index++)
    current = (
      await memory.execute({
        ...purchased,
        revision: current.revision,
        content: `Correction ${index}`,
      })
    ).entries[0]!;
  const page = await memory.execute({ operation: "history", key: current.key, offset: 0 });
  expect(page.entries).toHaveLength(5);
  expect(page.nextOffset).toBe(5);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(12000);
  const full = await memory.execute({
    operation: "get",
    key: current.key,
    revision: original.revision,
  });
  expect(full.entries[0]?.content).toBe(original.content);
  expect(
    (await memory.execute({ operation: "history", key: current.key, offset: 5 })).entries,
  ).toHaveLength(2);
});

test("searching archived personal memory does not return active notes", async () => {
  const { memory } = await subject();
  const entry = (await memory.execute(purchased)).entries[0]!;
  await memory.execute({ operation: "archive", key: entry.key, revision: entry.revision });
  expect(
    (await memory.execute({ operation: "search", query: "域名", archived: true })).entries.map(
      (entry) => entry.key,
    ),
  ).toContain(entry.key);
  expect((await memory.execute({ operation: "search", query: "域名" })).entries).toHaveLength(0);
});
