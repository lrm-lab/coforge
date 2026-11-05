import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStartupMemoryBlock,
  STARTUP_MEMORY_BUDGET_TOKENS,
} from "#src/agent-runtime/startup-memory-block";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-memory-block-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

async function workspaceFile(path: string, content: string): Promise<void> {
  const full = join(directory, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

test("a small MEMORY.md and Active Context are injected whole and marked complete", async () => {
  await workspaceFile("MEMORY.md", "# Memory\n- prefers squash merges\n");
  await workspaceFile("notes/active-context.md", "# Active Context\n- next: read the diff\n");
  const built = await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory });
  expect(built?.complete).toBe(true);
  expect(built?.text).toBe(
    [
      "<memory-index>",
      '<memory file="MEMORY.md" size="0.0 KB" complete="true" note="no need to re-read MEMORY.md unless you change it">',
      "# Memory",
      "- prefers squash merges",
      "</memory>",
      '<active-context file="notes/active-context.md" size="0.0 KB" complete="true" note="no need to re-read notes/active-context.md unless you change it">',
      "# Active Context",
      "- next: read the diff",
      "</active-context>",
      "</memory-index>",
    ].join("\n"),
  );
});

test("only the file that has content is injected", async () => {
  await workspaceFile("notes/active-context.md", "- next: read the diff\n");
  const built = await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory });
  expect(built?.text).toContain("<active-context ");
  expect(built?.text).not.toContain("<memory ");
});

test("a MEMORY.md past its share is cut at a line end and says how to read the rest", async () => {
  const lines = Array.from({ length: 900 }, (_, index) => `- entry ${index} ${"x".repeat(40)}`);
  await workspaceFile("MEMORY.md", lines.join("\n"));
  const built = await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory });
  expect(built?.complete).toBe(false);
  const block = built!.text;
  expect(block).toContain('note="read the file for the rest"');
  expect(block).toMatch(/<memory file="MEMORY\.md" shown="first \d+\.\d KB" tokens="~\d+"/);
  const body = block.split("\n");
  expect(body.length).toBeLessThan(lines.length);
  // Cut at its own share, never spending the Active Context's.
  expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(
    STARTUP_MEMORY_BUDGET_TOKENS * 4 + 400,
  );
});

test("the Active Context has its own share: a short MEMORY.md does not lend it more", async () => {
  await workspaceFile("MEMORY.md", "# Memory\n");
  await workspaceFile(
    "notes/active-context.md",
    Array.from({ length: 400 }, (_, index) => `- line ${index} ${"y".repeat(40)}`).join("\n"),
  );
  const built = await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory });
  expect(built?.complete).toBe(false);
  const active = built!.text.slice(built!.text.indexOf("<active-context "));
  expect(Buffer.byteLength(active, "utf8")).toBeLessThanOrEqual(1_000 * 4 + 400);
});

test("a multi-byte character cut by the share is dropped, not half-kept", async () => {
  // 2 bytes each, past the 12,000-byte share: the cut can fall inside a character.
  await workspaceFile("MEMORY.md", `abc${"\u00e9".repeat(10_000)}`);
  const built = await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory });
  expect(built?.complete).toBe(false);
  const body = built!.text.split("\n").slice(2, -2);
  expect(body.join("\n").startsWith("abc")).toBe(true);
  expect(built!.text).not.toContain("\uFFFD");
});

test("no file, an empty file or a blank file contributes no section", async () => {
  expect(await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory })).toBeUndefined();
  await workspaceFile("MEMORY.md", "");
  await workspaceFile("notes/active-context.md", "  \n\n");
  expect(await buildStartupMemoryBlock({ agentWorkspaceDirectory: directory })).toBeUndefined();
});

test("a symlinked or directory file is never read", async () => {
  const secret = join(directory, "secret.txt");
  await writeFile(secret, "top secret");
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await symlink(secret, join(workspace, "MEMORY.md"));
  expect(await buildStartupMemoryBlock({ agentWorkspaceDirectory: workspace })).toBeUndefined();
  const other = join(directory, "other");
  await mkdir(join(other, "MEMORY.md"), { recursive: true });
  expect(await buildStartupMemoryBlock({ agentWorkspaceDirectory: other })).toBeUndefined();
});
