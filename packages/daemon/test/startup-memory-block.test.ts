import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStartupMemoryBlock } from "#src/agent-runtime/startup-memory-block";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-memory-block-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

test("a small MEMORY.md is injected whole and marked complete", async () => {
  await writeFile(join(directory, "MEMORY.md"), "# Memory\n- [note](notes/a.md)\n");
  const built = await buildStartupMemoryBlock({
    agentWorkspaceDirectory: directory,
    budgetTokens: 4_000,
  });
  expect(built?.complete).toBe(true);
  expect(built?.text).toBe(
    [
      '<memory-index file="MEMORY.md" size="0.0 KB" complete="true" note="no need to re-read MEMORY.md unless you change it">',
      "# Memory",
      "- [note](notes/a.md)",
      "</memory-index>",
    ].join("\n"),
  );
});

test("a MEMORY.md past the budget is cut at a line end and says how to read the rest", async () => {
  const lines = Array.from({ length: 400 }, (_, index) => `- entry ${index} ${"x".repeat(40)}`);
  await writeFile(join(directory, "MEMORY.md"), lines.join("\n"));
  const built = await buildStartupMemoryBlock({
    agentWorkspaceDirectory: directory,
    budgetTokens: 500,
  });
  expect(built?.complete).toBe(false);
  const block = built?.text;
  expect(block).toContain('note="read the file for the rest"');
  expect(block).toMatch(/tokens="~\d+" shown="first \d+\.\d KB"/);
  const body = block!.split("\n").slice(1, -1);
  expect(body.length).toBeLessThan(lines.length);
  // Ends on a whole line, never part of one.
  expect(body.at(-1)).toBe(lines[body.length - 1]!);
  expect(Buffer.byteLength(body.join("\n"))).toBeLessThanOrEqual(2000);
});

test("a multi-byte character cut by the budget is dropped, not half-kept", async () => {
  await writeFile(join(directory, "MEMORY.md"), `abc${"\u00e9".repeat(100)}`);
  const built = await buildStartupMemoryBlock({
    agentWorkspaceDirectory: directory,
    budgetTokens: 1,
  });
  const block = built?.text;
  expect(block?.split("\n").slice(1, -1)).toEqual(["abc"]);
  expect(block).not.toContain("\uFFFD");
});

test("a missing, empty or blank MEMORY.md has no block", async () => {
  expect(
    await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory, budgetTokens: 4_000 }),
  ).toBeUndefined();
  await writeFile(join(directory, "MEMORY.md"), "");
  expect(
    await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory, budgetTokens: 4_000 }),
  ).toBeUndefined();
  await writeFile(join(directory, "MEMORY.md"), "  \n\n");
  expect(
    await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory, budgetTokens: 4_000 }),
  ).toBeUndefined();
});

test("a symlinked or directory MEMORY.md is never read", async () => {
  const secret = join(directory, "secret.txt");
  await writeFile(secret, "top secret");
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await symlink(secret, join(workspace, "MEMORY.md"));
  expect(
    await buildStartupMemoryBlock({ agentWorkspaceDirectory: workspace, budgetTokens: 4_000 }),
  ).toBeUndefined();
  const other = join(directory, "other");
  await mkdir(join(other, "MEMORY.md"), { recursive: true });
  expect(
    await buildStartupMemoryBlock({ agentWorkspaceDirectory: other, budgetTokens: 4_000 }),
  ).toBeUndefined();
});
