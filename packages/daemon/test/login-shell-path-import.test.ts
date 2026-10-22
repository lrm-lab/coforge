import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { LoginShellPathResult } from "#src/platform/login-shell-path";
import { readLoginShellPath, writeLoginShellPath } from "#src/platform/login-shell-path-state";
import { startLoginShellPathImport } from "#src/supervisor/login-shell-path-import";
import { captureDaemonLogs } from "./log-capture";

const roots: string[] = [];
function newStateDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "coforge-login-path-import-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("starting the import returns at once and records the result when the probe settles", async () => {
  const dir = newStateDirectory();
  let release!: (result: LoginShellPathResult) => void;
  const probe = () => new Promise<LoginShellPathResult>((resolve) => (release = resolve));
  const { records } = await captureDaemonLogs(async () => {
    const started = startLoginShellPathImport(dir, probe);
    expect(readLoginShellPath(dir)).toBeUndefined();
    release({ ok: true, path: ["/opt/one"], shell: "/bin/zsh", durationMs: 3 });
    await started.done;
    return started;
  });
  expect(readLoginShellPath(dir)).toMatchObject({ ok: true, path: ["/opt/one"] });
  expect(records.map((record) => record.properties.event)).toContain("login_shell_path:imported");
});

test("a failed probe replaces an earlier success and logs its reason", async () => {
  const dir = newStateDirectory();
  await writeLoginShellPath(dir, {
    ok: true,
    path: ["/opt/old"],
    shell: "/bin/zsh",
    durationMs: 1,
  });
  const { records } = await captureDaemonLogs(async () => {
    const started = startLoginShellPathImport(dir, async () => ({
      ok: false,
      reason: "timeout",
      shell: "/bin/zsh",
      durationMs: 10_000,
    }));
    await started.done;
  });
  expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason: "timeout" });
  expect(records.find((record) => record.properties.reason === "timeout")).toBeDefined();
});

test("stopping abandons the probe and leaves the stored result alone", async () => {
  const dir = newStateDirectory();
  await writeLoginShellPath(dir, {
    ok: true,
    path: ["/opt/old"],
    shell: "/bin/zsh",
    durationMs: 1,
  });
  const started = startLoginShellPathImport(dir, async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
    return { ok: false, reason: "aborted", durationMs: 1 };
  });
  started.stop();
  await started.done;
  expect(readLoginShellPath(dir)).toMatchObject({ ok: true, path: ["/opt/old"] });
});

test("a probe that throws replaces an earlier success with an internal_error record", async () => {
  const dir = newStateDirectory();
  await writeLoginShellPath(dir, {
    ok: true,
    path: ["/opt/old"],
    shell: "/bin/zsh",
    durationMs: 1,
  });
  await captureDaemonLogs(async () => {
    await startLoginShellPathImport(dir, async () => {
      throw new Error("boom");
    }).done;
  });
  expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason: "internal_error" });
});

test("a failing state write is logged, tries the failure record, and never rejects", async () => {
  const dir = path.join(newStateDirectory(), "missing", "nested");
  // Unwritable (a file stands where the directory should be): both writes fail quietly.
  writeFileSync(path.dirname(dir), "x");
  const { records } = await captureDaemonLogs(async () => {
    await startLoginShellPathImport(dir, async () => ({
      ok: true,
      path: ["/opt/one"],
      shell: "/bin/zsh",
      durationMs: 1,
    })).done;
  });
  expect(records.some((record) => record.properties.event === "login_shell_path:failed")).toBe(
    true,
  );
});

test("a probe that throws is logged and never rejects", async () => {
  const dir = newStateDirectory();
  const { records } = await captureDaemonLogs(async () => {
    await startLoginShellPathImport(dir, async () => {
      throw new Error("boom");
    }).done;
  });
  expect(
    records.find((record) => record.properties.event === "login_shell_path:failed"),
  ).toBeDefined();
});
