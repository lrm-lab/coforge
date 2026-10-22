import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { LoginShellPathResult } from "#src/platform/login-shell-path";
import {
  LOGIN_SHELL_PATH_FILE,
  loginShellPathDirectories,
  readLoginShellPath,
  supervisorStateDirectory,
  writeLoginShellPath,
} from "#src/platform/login-shell-path-state";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";

const roots: string[] = [];
function newStateDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "coforge-login-path-state-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const success: LoginShellPathResult = {
  ok: true,
  path: ["/opt/one", "/opt/two"],
  shell: "/bin/zsh",
  durationMs: 12,
};
const failure: LoginShellPathResult = {
  ok: false,
  reason: "timeout",
  shell: "/bin/zsh",
  durationMs: 10_000,
};

describe("login-shell-path.json", () => {
  test("is written owner-only, atomically, and read back", async () => {
    const dir = newStateDirectory();
    await writeLoginShellPath(dir, success, new Date("2026-01-01T00:00:00Z"));
    expect(statSync(path.join(dir, LOGIN_SHELL_PATH_FILE)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([LOGIN_SHELL_PATH_FILE]);
    expect(readLoginShellPath(dir)).toEqual({ ...success, at: "2026-01-01T00:00:00.000Z" });
  });

  test("a failure overwrites an earlier success, so no stale PATH survives", async () => {
    const dir = newStateDirectory();
    await writeLoginShellPath(dir, success);
    await writeLoginShellPath(dir, failure);
    expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason: "timeout" });
    expect(loginShellPathDirectories(dir)).toEqual([]);
  });

  test("a missing, corrupt, or malformed file reads as undefined", async () => {
    const dir = newStateDirectory();
    expect(readLoginShellPath(dir)).toBeUndefined();
    const file = path.join(dir, LOGIN_SHELL_PATH_FILE);
    writeFileSync(file, "{not json");
    expect(readLoginShellPath(dir)).toBeUndefined();
    writeFileSync(
      file,
      JSON.stringify({ version: 1, ok: true, shell: "zsh", path: ["rel"], at: "x" }),
    );
    expect(readLoginShellPath(dir)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ version: 2, ok: false, reason: "timeout", at: "x" }));
    expect(readLoginShellPath(dir)).toBeUndefined();
    await writeLoginShellPath(dir, success);
    expect(readLoginShellPath(dir)).toMatchObject({ ok: true });
  });

  test("an unchanged file (same inode, mtime, size) is served from the cache", async () => {
    const dir = newStateDirectory();
    const file = path.join(dir, LOGIN_SHELL_PATH_FILE);
    await writeLoginShellPath(dir, success);
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(readLoginShellPath(dir)).toMatchObject({ ok: true, path: ["/opt/one", "/opt/two"] });
    // Same length, same mtime: only a cache can still answer with the old content.
    const text = await Bun.file(file).text();
    writeFileSync(file, text.replace("/opt/one", "/opt/uno"));
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(readLoginShellPath(dir)).toMatchObject({ path: ["/opt/one", "/opt/two"] });
    // A new mtime is noticed.
    utimesSync(file, 1_700_000_005, 1_700_000_005);
    expect(readLoginShellPath(dir)).toMatchObject({ path: ["/opt/uno", "/opt/two"] });
  });

  test("a Workspace Daemon finds the Coordinator's directory from its supervisor state path", () => {
    expect(
      supervisorStateDirectory({ COFORGE_SUPERVISOR_STATE_PATH: "/s/upgrade-request-ids.json" }),
    ).toBe("/s");
    expect(supervisorStateDirectory({})).toBeUndefined();
  });
});

describe("codeAgentExecutableSearchPath with a login-shell PATH", () => {
  test("orders the current PATH, the login-shell directories, then the defaults", async () => {
    const dir = newStateDirectory();
    await writeLoginShellPath(dir, success);
    const entries = codeAgentExecutableSearchPath(
      { HOME: "/home/u", PATH: "/ambient" },
      "linux",
      dir,
    ).split(":");
    expect(entries.slice(0, 4)).toEqual(["/ambient", "/opt/one", "/opt/two", "/home/u/.local/bin"]);
    expect(entries.indexOf("/opt/two")).toBeLessThan(entries.indexOf("/usr/local/bin"));
  });

  test("a failed probe, a missing file, or Windows adds nothing", async () => {
    const dir = newStateDirectory();
    const search = (platform: NodeJS.Platform, state: string | undefined) =>
      codeAgentExecutableSearchPath({ HOME: "/home/u", PATH: "/ambient" }, platform, state);
    expect(search("linux", dir)).not.toContain("/opt/one");
    await writeLoginShellPath(dir, failure);
    expect(search("linux", dir)).not.toContain("/opt/one");
    await writeLoginShellPath(dir, success);
    expect(search("win32", dir)).not.toContain("/opt/one");
    expect(search("linux", undefined)).not.toContain("/opt/one");
  });
});
