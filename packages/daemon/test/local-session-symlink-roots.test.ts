import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSessionCatalog } from "#src/local-session/local-session-catalog";
import { searchClaudeLocalSessions } from "@lrm/coforge-anvil/claude-code";
import { claudeHistoryHost } from "#src/code-agent/claude-code/history-host";

const roots: string[] = [];
const originalClaude = Bun.env.CLAUDE_CONFIG_DIR;
const originalCodex = Bun.env.CODEX_HOME;
afterEach(async () => {
  if (originalClaude === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
  else Bun.env.CLAUDE_CONFIG_DIR = originalClaude;
  if (originalCodex === undefined) delete Bun.env.CODEX_HOME;
  else Bun.env.CODEX_HOME = originalCodex;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), "coforge-local-session-roots-"));
  roots.push(path);
  return path;
}

test("Claude discovery rejects a symlinked projects root", async () => {
  const base = await root();
  const config = join(base, "claude");
  const outside = join(base, "outside-claude", "project");
  await mkdir(config, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    join(outside, "session-1.jsonl"),
    `${JSON.stringify({
      type: "user",
      timestamp: "2026-11-02T01:00:00Z",
      cwd: "/work/escaped",
      message: { role: "user", content: "must not leave the provider root" },
    })}\n`,
  );
  await symlink(join(base, "outside-claude"), join(config, "projects"), "dir");
  Bun.env.CLAUDE_CONFIG_DIR = config;
  Bun.env.CODEX_HOME = join(base, "missing-codex");
  expect((await new LocalSessionCatalog().search("")).sessions).toEqual([]);
});

test("Codex discovery rejects a symlinked sessions root", async () => {
  const base = await root();
  const home = join(base, "codex");
  const outside = join(base, "outside-codex", "2026", "11", "02");
  await mkdir(home, { recursive: true });
  await mkdir(outside, { recursive: true });
  const id = "11111111-2222-4333-8444-555555555555";
  await writeFile(
    join(outside, `rollout-2026-11-02T01-00-00-${id}.jsonl`),
    [
      JSON.stringify({
        timestamp: "2026-11-02T01:00:00Z",
        type: "session_meta",
        payload: { id, cwd: "/work/escaped" },
      }),
      JSON.stringify({
        timestamp: "2026-11-02T01:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "must not leave the provider root" }],
        },
      }),
    ].join("\n"),
  );
  await symlink(join(base, "outside-codex"), join(home, "sessions"), "dir");
  Bun.env.CLAUDE_CONFIG_DIR = join(base, "missing-claude");
  Bun.env.CODEX_HOME = home;
  expect((await new LocalSessionCatalog().search("")).sessions).toEqual([]);
});

test("a project swapped to a symlink after validation cannot escape the captured root", async () => {
  const base = await root();
  const config = join(base, "claude");
  const project = join(config, "projects", "project");
  const retained = join(config, "projects", "project-retained");
  const outside = join(base, "outside-project");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    join(outside, "session-1.jsonl"),
    `${JSON.stringify({
      type: "user",
      timestamp: "2026-11-02T01:00:00Z",
      cwd: "/work/escaped",
      message: { role: "user", content: "must not cross a swapped ancestor" },
    })}\n`,
  );
  Bun.env.CLAUDE_CONFIG_DIR = config;
  let swapped = false;
  const host = {
    ...claudeHistoryHost,
    async readDirectoryEntries(path: string) {
      if (!swapped && path === project) {
        swapped = true;
        await rename(project, retained);
        await symlink(outside, project, "dir");
      }
      return claudeHistoryHost.readDirectoryEntries(path);
    },
  };
  const now = Date.now;
  const result = await searchClaudeLocalSessions(
    {
      query: "",
      limits: {
        maxResults: 100,
        maxDirectories: 100,
        maxFiles: 100,
        maxContentBytes: 1024 * 1024,
        maxFileBytes: 1024 * 1024,
        deadlineAtMs: now() + 2_000,
        now,
      },
    },
    host,
  );
  expect(result.sessions).toEqual([]);
});
