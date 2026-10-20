import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAUNCHER_POLL_MS, SERVER_STOP_GRACE_MS } from "../scripts/launcher-contract";

// A local Web launcher (start-server, start-web, dev:hmr) runs its server as a Bun child. When the
// launcher went away, the server used to be adopted by PID 1 and keep running: these pin that the
// child now goes with it, whether the launcher is signalled or killed outright, and that a server
// which ignores the request to stop is killed once its grace is over.
const helper = join(import.meta.dir, "../scripts/supervised-bun.ts");
/** Injected through runSupervisedBun's stopGraceMs so a test does not wait out production's. */
const TEST_STOP_GRACE_MS = 1_000;
/** Room for a loaded machine. */
const MARGIN_MS = 3_000;
/** Two cold Bun starts: the launcher and its child. */
const STARTED_WITHIN_MS = 5_000;
/** The watcher notices within a poll, then the server has its grace. */
const STOPPED_WITHIN_MS = LAUNCHER_POLL_MS + TEST_STOP_GRACE_MS + MARGIN_MS;
const TEST_TIMEOUT_MS = STARTED_WITHIN_MS + 2 * STOPPED_WITHIN_MS;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(condition: () => boolean | Promise<boolean>, withinMs: number) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(50);
  }
  return condition();
}

/** The launcher's exit code, or "still running" if it has not exited within `withinMs`. */
const exitWithin = (launcher: Bun.Subprocess, withinMs: number) =>
  Promise.race([launcher.exited, Bun.sleep(withinMs).then(() => "still running" as const)]);

type Setup = { ignoreSigterm?: boolean; watchLauncher?: boolean };

/**
 * Runs `body` with a launcher that runs an idle child through runSupervisedBun, and kills both
 * and removes the directory afterwards, whatever happened.
 */
async function withLauncher(
  setup: Setup,
  body: (launcher: Bun.Subprocess, child: number) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "supervised-bun-"));
  const childPidFile = join(root, "child.pid");
  let launcher: Bun.Subprocess | undefined;
  let child: number | undefined;
  try {
    await writeFile(
      join(root, "child.ts"),
      (setup.ignoreSigterm ? `process.on("SIGTERM", () => {});\n` : "") +
        `await Bun.write(${JSON.stringify(childPidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 60_000);\n`,
    );
    const options = {
      cwd: root,
      stopGraceMs: TEST_STOP_GRACE_MS,
      ...(setup.watchLauncher === false ? { watchLauncher: false } : {}),
    };
    await writeFile(
      join(root, "launcher.ts"),
      `import { runSupervisedBun } from ${JSON.stringify(helper)};\n` +
        `process.exit(await runSupervisedBun([${JSON.stringify(join(root, "child.ts"))}], { ...${JSON.stringify(options)}, env: process.env }));\n`,
    );
    launcher = Bun.spawn([process.execPath, join(root, "launcher.ts")], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await waitFor(() => Bun.file(childPidFile).exists(), STARTED_WITHIN_MS)).toBe(true);
    child = Number(await Bun.file(childPidFile).text());
    expect(alive(child)).toBe(true);
    await body(launcher, child);
  } finally {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) launcher.kill(9);
    if (child !== undefined && alive(child)) process.kill(child, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

test("a server gets more than Nitro's own 5 s shutdown before it is killed", () => {
  expect(SERVER_STOP_GRACE_MS).toBe(10_000);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"] as const) {
  test(
    `the server child stops when its launcher gets ${signal}`,
    () =>
      withLauncher({}, async (launcher, child) => {
        launcher.kill(signal);
        await launcher.exited;
        expect(await waitFor(() => !alive(child), STOPPED_WITHIN_MS)).toBe(true);
      }),
    TEST_TIMEOUT_MS,
  );
}

for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
] as const) {
  test(
    `${signal} is passed on to the server without the watcher, and the launcher exits with the server's ${code}`,
    () =>
      withLauncher({ watchLauncher: false }, async (launcher, child) => {
        launcher.kill(signal);
        expect(await exitWithin(launcher, STOPPED_WITHIN_MS)).toBe(code);
        // The launcher waits for its child, so the child is gone before the launcher exits.
        expect(alive(child)).toBe(false);
      }),
    TEST_TIMEOUT_MS,
  );
}

test(
  "a server that ignores SIGTERM is killed after the grace, and the launcher exits with 137",
  () =>
    withLauncher({ ignoreSigterm: true }, async (launcher, child) => {
      launcher.kill("SIGTERM");
      expect(await exitWithin(launcher, STOPPED_WITHIN_MS)).toBe(137);
      expect(alive(child)).toBe(false);
    }),
  TEST_TIMEOUT_MS,
);

test(
  "a server that ignores SIGTERM still stops when its launcher is killed outright",
  () =>
    withLauncher({ ignoreSigterm: true }, async (launcher, child) => {
      launcher.kill("SIGKILL");
      await launcher.exited;
      expect(await waitFor(() => !alive(child), STOPPED_WITHIN_MS)).toBe(true);
    }),
  TEST_TIMEOUT_MS,
);
