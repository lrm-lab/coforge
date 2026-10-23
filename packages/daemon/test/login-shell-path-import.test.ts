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
    const started = startLoginShellPathImport(dir, { probe });
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
    const started = startLoginShellPathImport(dir, {
      probe: async () => ({
        ok: false,
        reason: "exit_nonzero",
        shell: "/bin/zsh",
        durationMs: 10,
      }),
    });
    await started.done;
  });
  expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason: "exit_nonzero" });
  expect(records.find((record) => record.properties.reason === "exit_nonzero")).toBeDefined();
});

test("stopping abandons the probe and leaves the stored result alone", async () => {
  const dir = newStateDirectory();
  await writeLoginShellPath(dir, {
    ok: true,
    path: ["/opt/old"],
    shell: "/bin/zsh",
    durationMs: 1,
  });
  const started = startLoginShellPathImport(dir, {
    probe: async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      return { ok: false, reason: "aborted", durationMs: 1 };
    },
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
    await startLoginShellPathImport(dir, {
      probe: async () => {
        throw new Error("boom");
      },
    }).done;
  });
  expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason: "internal_error" });
});

test("a failing state write is logged, tries the failure record, and never rejects", async () => {
  const dir = path.join(newStateDirectory(), "missing", "nested");
  // Unwritable (a file stands where the directory should be): both writes fail quietly.
  writeFileSync(path.dirname(dir), "x");
  const { records } = await captureDaemonLogs(async () => {
    await startLoginShellPathImport(dir, {
      probe: async () => ({ ok: true, path: ["/opt/one"], shell: "/bin/zsh", durationMs: 1 }),
    }).done;
  });
  expect(records.some((record) => record.properties.event === "login_shell_path:failed")).toBe(
    true,
  );
});

test("a probe that throws is logged and never rejects", async () => {
  const dir = newStateDirectory();
  const { records } = await captureDaemonLogs(async () => {
    await startLoginShellPathImport(dir, {
      probe: async () => {
        throw new Error("boom");
      },
    }).done;
  });
  expect(
    records.find((record) => record.properties.event === "login_shell_path:failed"),
  ).toBeDefined();
});

const timeout: LoginShellPathResult = {
  ok: false,
  reason: "timeout",
  shell: "/bin/zsh",
  durationMs: 10_000,
};
const success: LoginShellPathResult = {
  ok: true,
  path: ["/opt/one"],
  shell: "/bin/zsh",
  durationMs: 300,
};
const instantSleep = async () => {};

function scripted(results: LoginShellPathResult[]) {
  let calls = 0;
  return {
    probe: async () => results[Math.min(calls++, results.length - 1)]!,
    calls: () => calls,
  };
}

test("a timed-out probe is retried and a later success replaces the failure", async () => {
  const dir = newStateDirectory();
  const script = scripted([timeout, success]);
  const delays: number[] = [];
  const { records } = await captureDaemonLogs(async () => {
    await startLoginShellPathImport(dir, {
      probe: script.probe,
      retryDelaysMs: [30_000, 120_000, 600_000],
      sleep: async (ms) => void delays.push(ms),
    }).done;
  });
  expect(script.calls()).toBe(2);
  expect(delays).toEqual([30_000]);
  expect(readLoginShellPath(dir)).toMatchObject({ ok: true, path: ["/opt/one"] });
  expect(records.map((record) => [record.properties.event, record.properties.attempt])).toEqual([
    ["login_shell_path:skipped", 1],
    ["login_shell_path:imported", 2],
  ]);
});

test("a failure that would repeat is not retried", async () => {
  for (const reason of ["exit_nonzero", "unsupported_shell", "no_result", "disabled"] as const) {
    const dir = newStateDirectory();
    const script = scripted([{ ok: false, reason, durationMs: 1 }]);
    await captureDaemonLogs(async () => {
      await startLoginShellPathImport(dir, {
        probe: script.probe,
        retryDelaysMs: [1, 1, 1],
        sleep: instantSleep,
      }).done;
    });
    expect(script.calls()).toBe(1);
    expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason });
  }
});

test("retries stop after the third and the give-up is logged", async () => {
  const dir = newStateDirectory();
  const script = scripted([timeout]);
  const { records } = await captureDaemonLogs(async () => {
    await startLoginShellPathImport(dir, {
      probe: script.probe,
      retryDelaysMs: [1, 1, 1],
      sleep: instantSleep,
    }).done;
  });
  expect(script.calls()).toBe(4);
  expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason: "timeout" });
  expect(records.map((record) => record.properties.event)).toContain("login_shell_path:gave_up");
});

test("stopping during a retry wait resolves at once and writes nothing more", async () => {
  const dir = newStateDirectory();
  const script = scripted([timeout, success]);
  const started = startLoginShellPathImport(dir, {
    probe: script.probe,
    retryDelaysMs: [60_000],
  });
  while (readLoginShellPath(dir)?.ok !== false) await new Promise((r) => setTimeout(r, 1));
  const began = Date.now();
  await started.stop();
  await started.done;
  expect(Date.now() - began).toBeLessThan(1_000);
  expect(script.calls()).toBe(1);
  expect(readLoginShellPath(dir)).toMatchObject({ ok: false, reason: "timeout" });
});
