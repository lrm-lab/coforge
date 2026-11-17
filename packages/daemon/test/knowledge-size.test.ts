import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemory } from "#src/local-memory/local-memory";
import { measureKnowledgeSize } from "#src/local-memory/knowledge-size";

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function root() {
  const path = await mkdtemp(join(tmpdir(), "coforge-knowledge-size-"));
  roots.push(path);
  return path;
}

test("size inspection reads bounded metadata, so a long whitespace prefix cannot hide a saved fact", async () => {
  const path = await root();
  await new LocalMemory(path).execute({
    operation: "save",
    key: "decision",
    revision: "new",
    title: "Decision",
    content: " ".repeat(15_990) + "confirmed",
    source: "源".repeat(1_000),
    applicability: "production",
    kind: "decision",
  });
  const result = await measureKnowledgeSize(path);
  expect(result.kind).toBe("measured");
  if (result.kind === "measured") expect(result.bytes).toBeGreaterThan(16_384);
});

test("a large directory reports its partial scan and a linked knowledge directory is refused", async () => {
  const path = await root();
  await Promise.all(
    Array.from({ length: 513 }, (_, i) =>
      mkdir(join(path, "notes/knowledge", String(i)), { recursive: true }),
    ),
  );
  expect(await measureKnowledgeSize(path)).toMatchObject({ kind: "measured", incomplete: true });
  const linked = await root();
  await mkdir(join(linked, "notes"));
  await symlink(join(path, "notes/knowledge"), join(linked, "notes/knowledge"));
  expect(await measureKnowledgeSize(linked)).toMatchObject({ kind: "not_established" });
});
