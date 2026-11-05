import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInitialMemoryMd, seedAgentMemory } from "#src/agent-runtime/agent-memory-seed";

test("buildInitialMemoryMd renders the displayName, rules, a facts area and pointers, with no role", () => {
  const content = buildInitialMemoryMd({
    name: "scout",
    displayName: "Scout",
  });
  expect(content).toBe(`# Scout

## Rules (never change)
-

## Facts
<!-- One fact per line. When a human decides or prefers something, or you hit a pitfall, edit the
line here and merge duplicates. -->

## Pointers
- notes/active-context.md   current state: next step, blocker, progress (overwrite it as work moves)
- notes/<topic>.md   long material (procedures, reports, reference); one line here pointing at it
`);
  expect(content).not.toContain("Active Context");
  expect(content).not.toContain("## Role");
  // The role is the description, which the standing prompt carries; a copy here would go stale.
  expect(content).not.toContain("Reviews pull requests");
});

test("buildInitialMemoryMd falls back to name, then a generic title, when displayName is missing", () => {
  expect(buildInitialMemoryMd({ name: "scout" })).toContain("# scout\n");
  expect(buildInitialMemoryMd({})).toContain("# Agent\n");
});

test("a description is never copied into the seed, known or not", () => {
  const identity = { name: "scout", displayName: "Scout", description: "Reviews pull requests." };
  const content = buildInitialMemoryMd(identity as never);
  expect(content).not.toContain("## Role");
  expect(content).not.toContain("Reviews pull requests");
});

test("buildInitialMemoryMd collapses a name's newlines into the one heading", () => {
  const content = buildInitialMemoryMd({ displayName: "Scout\nthe Builder" });
  expect(content.startsWith("# Scout the Builder\n")).toBe(true);
});

test("seedAgentMemory writes MEMORY.md into the Agent workspace with owner-only permissions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-"));
  try {
    await seedAgentMemory(workspace, { name: "scout" });
    const memoryPath = join(workspace, "MEMORY.md");
    const content = await readFile(memoryPath, "utf8");
    expect(content).toBe(buildInitialMemoryMd({ name: "scout" }));
    const stats = await stat(memoryPath);
    expect(stats.mode & 0o777).toBe(0o600);
    // The seed no longer creates a chronological work log: the facts live in MEMORY.md.
    await expect(stat(join(workspace, "notes", "work-log.md"))).rejects.toThrow();
    const activeContextPath = join(workspace, "notes", "active-context.md");
    const activeContext = await readFile(activeContextPath, "utf8");
    expect(activeContext).toContain("# Active Context");
    expect(activeContext).toContain("Current state, not a log");
    expect(activeContext.trimEnd().split("\n").length).toBeLessThanOrEqual(5);
    expect((await stat(activeContextPath)).mode & 0o777).toBe(0o600);
    // As in the reference Computer, the workspace is not made ready for git: no .gitignore.
    await expect(stat(join(workspace, ".gitignore"))).rejects.toThrow();
    expect((await stat(join(workspace, "code"))).isDirectory()).toBe(true);
    await expect(stat(join(workspace, "work"))).rejects.toThrow();
    const migrateIgnore = await readFile(join(workspace, ".coforgemigrateignore"), "utf8");
    expect(migrateIgnore.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([
      "code",
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedAgentMemory never overwrites an existing MEMORY.md, byte for byte", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-existing-"));
  try {
    const memoryPath = join(workspace, "MEMORY.md");
    const ownedContent = "# Scout\n\n## Role\nWhatever the Agent decided to keep here.\n";
    await writeFile(memoryPath, ownedContent, { encoding: "utf8", mode: 0o600 });

    await seedAgentMemory(workspace, { name: "scout" });

    expect(await readFile(memoryPath, "utf8")).toBe(ownedContent);
    expect((await stat(join(workspace, "notes"))).isDirectory()).toBe(true);
    expect((await stat(join(workspace, "code"))).isDirectory()).toBe(true);
    // A workspace seeded before the work log was dropped still gets the notes layout, but no
    // new work log is written for it either.
    await expect(stat(join(workspace, "notes", "work-log.md"))).rejects.toThrow();
    expect(await readFile(join(workspace, "notes", "active-context.md"), "utf8")).toContain(
      "# Active Context",
    );
    expect(await readFile(join(workspace, ".coforgemigrateignore"), "utf8")).toContain("code");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedAgentMemory never overwrites an existing .coforgemigrateignore", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-migrate-ignore-"));
  try {
    // The Agent chose to carry its code: it removed `code` from the list.
    const ownedContent = "big-data/\n";
    await writeFile(join(workspace, ".coforgemigrateignore"), ownedContent, "utf8");
    await seedAgentMemory(workspace, { name: "scout" });
    expect(await readFile(join(workspace, ".coforgemigrateignore"), "utf8")).toBe(ownedContent);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedAgentMemory never overwrites an existing notes/active-context.md, byte for byte", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-active-context-"));
  try {
    await mkdir(join(workspace, "notes"));
    const activeContextPath = join(workspace, "notes", "active-context.md");
    const ownedContent = "- Doing: migrate the billing tables\n- Next: run the backfill\n";
    await writeFile(activeContextPath, ownedContent, { encoding: "utf8", mode: 0o600 });

    await seedAgentMemory(workspace, { name: "scout" });

    expect(await readFile(activeContextPath, "utf8")).toBe(ownedContent);
    expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe(
      buildInitialMemoryMd({ name: "scout" }),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedAgentMemory does not throw when the workspace directory does not exist", async () => {
  const missingWorkspace = join(
    tmpdir(),
    `coforge-agent-memory-seed-missing-${crypto.randomUUID()}`,
  );
  await expect(seedAgentMemory(missingWorkspace, { name: "scout" })).resolves.toBeUndefined();
});
