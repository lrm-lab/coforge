import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Shared by the install.sh tests: the disposable resources a test registers (its own
 * `afterEach` removes them), a stub feed, and a runner that gives every run a disposable HOME. */
export const temporaryDirectories: string[] = [];
export const servers: Array<ReturnType<typeof Bun.serve>> = [];

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
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, home };
}
