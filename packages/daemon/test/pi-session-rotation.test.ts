import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getCoforgeSessionDir,
  prepareAgentSessionDirectory,
  resolveAgentSessionFile,
  rotatePiSessionFileIfOversized,
} from "@coforge/agent";

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "coforge-daemon-pi-rot-"));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

test("oversized CoForge/Pi session JSONL rotates cleanly and remains discoverable by resolveAgentSessionFile", async () => {
  const sessionDir = getCoforgeSessionDir(workspaceDir);
  await mkdir(sessionDir, { recursive: true });
  const canonicalWorkspace = await prepareAgentSessionDirectory(resolve(workspaceDir), sessionDir);
  const file = join(sessionDir, "2026-11-17T12-00-00-000Z_agent-pi-1.jsonl");

  const lines: unknown[] = [
    {
      type: "session",
      version: 3,
      id: "agent-pi-1",
      timestamp: "2026-11-17T12:00:00.000Z",
      cwd: canonicalWorkspace,
    },
  ];
  let parentId: string | null = null;
  for (let i = 0; i < 10; i++) {
    const uId = `u-${i}`;
    lines.push({
      type: "message",
      id: uId,
      parentId,
      timestamp: "2026-11-17T12:01:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: `turn ${i} ${"A".repeat(10_000)}` }],
        timestamp: 1_763_380_860_000 + i,
      },
    });
    const aId = `a-${i}`;
    lines.push({
      type: "message",
      id: aId,
      parentId: uId,
      timestamp: "2026-11-17T12:01:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `reply ${i} ${"B".repeat(10_000)}` }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1_763_380_860_500 + i,
      },
    });
    parentId = aId;
  }
  const keptId = "u-kept";
  lines.push({
    type: "message",
    id: keptId,
    parentId,
    timestamp: "2026-11-17T12:05:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "recent user prompt" }],
      timestamp: 1_763_381_100_000,
    },
  });
  lines.push({
    type: "compaction",
    id: "comp-1",
    parentId: keptId,
    timestamp: "2026-11-17T12:06:00.000Z",
    summary: "Compacted 10 turns",
    firstKeptEntryId: keptId,
    tokensBefore: 255_000,
  });

  await writeFile(file, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  expect((await stat(file)).size).toBeGreaterThan(180_000);

  const rotated = await rotatePiSessionFileIfOversized(file, {
    workspaceDir: canonicalWorkspace,
    sessionDir,
    maxBytes: 24_000,
  });
  expect(rotated.rotated).toBe(true);
  expect((await stat(file)).size).toBeLessThan(10_000);
  expect(await resolveAgentSessionFile(workspaceDir, sessionDir, "agent-pi-1")).toBe(file);
  expect((await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
});
