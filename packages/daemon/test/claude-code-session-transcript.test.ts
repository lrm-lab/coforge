import { afterEach, expect, test } from "bun:test";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findClaudeSessionTranscript,
  readClaudeSessionResumeFacts,
} from "#src/code-agent/claude-code/session-transcript";
import { assistantRecord, claudeConfigFixture } from "./claude-transcript-fixtures";

const fixtures: Awaited<ReturnType<typeof claudeConfigFixture>>[] = [];
async function fixture() {
  const created = await claudeConfigFixture();
  fixtures.push(created);
  return created;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((created) => created.remove()));
});

test("finds the transcript under any project directory of CLAUDE_CONFIG_DIR", async () => {
  const claude = await fixture();
  const path = await claude.transcript(
    "sess-1",
    [assistantRecord({ timestamp: "2026-10-23T00:00:00Z" })],
    "-a-b",
  );
  await claude.transcript("sess-2", [], "-c-d");
  expect(await findClaudeSessionTranscript("sess-1", claude.envVars)).toBe(path);
});

test("an absent session, a subagent file and a session-named directory are not transcripts", async () => {
  const claude = await fixture();
  await mkdir(join(claude.configDir, "projects", "-p", "sess-1", "subagents"), { recursive: true });
  await writeFile(
    join(claude.configDir, "projects", "-p", "sess-1", "subagents", "agent-x.jsonl"),
    "{}\n",
  );
  expect(await findClaudeSessionTranscript("sess-1", claude.envVars)).toBeUndefined();
  expect(await findClaudeSessionTranscript("", claude.envVars)).toBeUndefined();
  expect(await findClaudeSessionTranscript("../sess-1", claude.envVars)).toBeUndefined();
});

test("a missing config directory or a relative CLAUDE_CONFIG_DIR finds nothing", async () => {
  expect(
    await findClaudeSessionTranscript("sess-1", {
      CLAUDE_CONFIG_DIR: "/nonexistent/claude-config",
    }),
  ).toBeUndefined();
  expect(
    await findClaudeSessionTranscript("sess-1", { CLAUDE_CONFIG_DIR: "relative/dir" }),
  ).toBeUndefined();
});

test("a transcript that is a symlink is not followed", async () => {
  const claude = await fixture();
  const real = await claude.transcript("real", [
    assistantRecord({ timestamp: "2026-10-23T00:00:00Z" }),
  ]);
  await symlink(real, join(claude.configDir, "projects", "-work-project", "linked.jsonl"));
  expect(await findClaudeSessionTranscript("linked", claude.envVars)).toBeUndefined();
});

test("facts: latest timestamp and the last assistant record's summed usage", async () => {
  const claude = await fixture();
  await claude.transcript("sess-1", [
    assistantRecord({
      timestamp: "2026-10-23T01:00:00.000Z",
      usage: { input: 1, cacheRead: 100, cacheCreate: 10 },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-23T01:05:00.000Z",
      message: { role: "user", content: "hi" },
    }),
    assistantRecord({
      timestamp: "2026-10-23T01:10:00.000Z",
      usage: { input: 4, cacheRead: 200_000, cacheCreate: 5_000 },
    }),
    JSON.stringify({ type: "system", timestamp: "2026-10-23T01:07:00.000Z" }),
  ]);
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "sess-1", envVars: claude.envVars }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T01:10:00.000Z"),
    lastContextTokens: 205_004,
  });
});

test("facts: an assistant record without usage tokens keeps the earlier reading; sidechains are skipped", async () => {
  const claude = await fixture();
  await claude.transcript("sess-1", [
    assistantRecord({
      timestamp: "2026-10-23T01:00:00.000Z",
      usage: { input: 2, cacheRead: 300, cacheCreate: 0 },
    }),
    assistantRecord({
      timestamp: "2026-10-23T01:01:00.000Z",
      usage: { input: 0, cacheRead: 0, cacheCreate: 0 },
    }),
    assistantRecord({ timestamp: "2026-10-23T01:02:00.000Z" }),
    assistantRecord({
      timestamp: "2026-10-23T01:03:00.000Z",
      usage: { input: 9, cacheRead: 9_000, cacheCreate: 0 },
      isSidechain: true,
    }),
  ]);
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "sess-1", envVars: claude.envVars }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T01:03:00.000Z"),
    lastContextTokens: 302,
  });
});

test("facts: malformed lines and non-record JSON are skipped", async () => {
  const claude = await fixture();
  await claude.transcript("sess-1", [
    "not json {",
    "[1,2]",
    "null",
    JSON.stringify({ type: "assistant", timestamp: "garbage", message: { usage: "x" } }),
    assistantRecord({
      timestamp: "2026-10-23T02:00:00.000Z",
      usage: { input: 1, cacheRead: 1, cacheCreate: 1 },
    }),
  ]);
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "sess-1", envVars: claude.envVars }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T02:00:00.000Z"),
    lastContextTokens: 3,
  });
});

test("facts: reads only the last 512 KiB, starting after the line the window cuts", async () => {
  const claude = await fixture();
  const padding = JSON.stringify({
    type: "user",
    timestamp: "2030-01-01T00:00:00.000Z",
    pad: "x".repeat(600 * 1024),
  });
  await claude.transcript("sess-1", [
    assistantRecord({
      timestamp: "2031-01-01T00:00:00.000Z",
      usage: { input: 999, cacheRead: 0, cacheCreate: 0 },
    }),
    padding,
    assistantRecord({
      timestamp: "2026-10-23T03:00:00.000Z",
      usage: { input: 1, cacheRead: 2, cacheCreate: 3 },
    }),
  ]);
  // The early record lies wholly before the window and the padding line straddles its start.
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "sess-1", envVars: claude.envVars }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-23T03:00:00.000Z"),
    lastContextTokens: 6,
  });
});

test("facts: the sidecar directory's latest mtime counts as activity", async () => {
  const claude = await fixture();
  const path = await claude.transcript("sess-1", [
    assistantRecord({
      timestamp: "2026-10-23T01:00:00.000Z",
      usage: { input: 1, cacheRead: 1, cacheCreate: 1 },
    }),
  ]);
  const sidecar = join(path.replace(/\.jsonl$/, ""), "tool-results");
  await mkdir(sidecar, { recursive: true });
  const touched = new Date("2026-10-23T05:00:00.000Z");
  await utimes(sidecar, touched, touched);
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(path.replace(/\.jsonl$/, ""), old, old);
  const facts = await readClaudeSessionResumeFacts({
    sessionId: "sess-1",
    envVars: claude.envVars,
  });
  expect(facts?.lastActivityAtMs).toBe(touched.getTime());
  expect(facts?.lastContextTokens).toBe(3);
});

test("facts: absent or unreadable transcripts are undefined", async () => {
  const claude = await fixture();
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "nope", envVars: claude.envVars }),
  ).toBeUndefined();
  // A directory where the transcript file should be: found by name, unreadable as a file.
  await mkdir(join(claude.configDir, "projects", "-p", "dir-session.jsonl"), { recursive: true });
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "dir-session", envVars: claude.envVars }),
  ).toBeUndefined();
});

test("an empty transcript yields no fields", async () => {
  const claude = await fixture();
  await claude.transcript("sess-1", []);
  expect(
    await readClaudeSessionResumeFacts({ sessionId: "sess-1", envVars: claude.envVars }),
  ).toEqual({});
});
