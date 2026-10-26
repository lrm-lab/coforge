import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Shared by the install.sh tests: the disposable resources a test registers (its own
 * `afterEach` removes them), a stub feed, and a runner that gives every run a disposable HOME. */
export const temporaryDirectories: string[] = [];
export const servers: Array<ReturnType<typeof Bun.serve>> = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/** What every install.sh test's `afterEach` runs. The order matters: a test that timed out (or
 * threw) leaves its script running, and a script still writing into a directory that was already
 * removed fails the next test with ENOENT. So stop the feed, kill and reap every script, and only
 * then remove the directories. */
export async function cleanupInstallerFixtures(): Promise<void> {
  for (const server of servers.splice(0)) server.stop(true);
  const running = [...children];
  children.clear();
  // install.sh runs curl, gzip and shasum as children of its shell, so the whole group is killed.
  for (const child of running) killGroup(child.pid);
  await Promise.all(running.map((child) => child.exited));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

/** A stub feed on 127.0.0.1, which URLs name: `localhost` may reach another process on ::1. */
export function serveStub(options: { fetch(request: Request): Response | Promise<Response> }) {
  const server = Bun.serve({ ...options, hostname: "127.0.0.1", port: 0 });
  servers.push(server);
  return server;
}

export const script = resolve(import.meta.dir, "../../../scripts/release/install.sh");

/** Bun.spawnSync blocks the whole JS thread, including the fixture Bun.serve running in this
 * same process - a synchronous spawn here would deadlock the moment the script tries to reach
 * the fixture server. Bun.spawn keeps the event loop free so the fixture can respond. */
export async function run(
  args: string[],
  env: Record<string, string | undefined>,
  isolatedHome?: string,
  shellRoots: { zdotdir?: string; xdgConfigHome?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; home: string }> {
  // Every installer execution gets a disposable HOME. This is a safety boundary, not just test
  // cleanup: behavior tests exercise shell startup-file persistence and must never append to the
  // developer's real shell configuration, even when callers spread process.env.
  const home = isolatedHome ?? (await mkdtemp(join(tmpdir(), "coforge-installer-home-")));
  if (!isolatedHome) temporaryDirectories.push(home);
  const child = Bun.spawn({
    cmd: [script, ...args],
    env: {
      ...env,
      HOME: home,
      ZDOTDIR: shellRoots.zdotdir ?? home,
      XDG_CONFIG_HOME: shellRoots.xdgConfigHome ?? join(home, ".config"),
    },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  children.add(child);
  void child.exited.then(() => children.delete(child));
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, home };
}
