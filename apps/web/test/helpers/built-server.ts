/**
 * The built server a test runs (`mise run build`), found from the working directory (`apps/web`,
 * or the runtime image's `/app`). The image build binds this file with `production.integration.ts`
 * and nothing else, so it imports nothing from the source tree.
 */
export const BUILT_SERVER_ENTRY = ".output/server/index.mjs";

/** How long a test waits for the built server to answer `/health` after it starts. */
export const BUILT_SERVER_BOOT_MS = 10_000;

/** Test-runner time on top of the waits a test performs, for spawning, collecting and killing. */
export const TEST_SLACK_MS = 5_000;

export interface BuiltServer {
  readonly process: ReturnType<typeof Bun.spawn>;
  /** The first free port, if `PORT` was not given. */
  readonly port: number;
  /** Stdout and stderr, once the process has ended. */
  readonly output: Promise<string>;
}

/** An unused local port: bound and released, so the server can take it. */
export function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/**
 * Starts the built server with exactly `env` plus `PATH` and production mode, so the ambient
 * `CI`/`TEST` (which turn srvx's shutdown handling off) cannot change what is under test.
 */
export function spawnBuiltServer(env: Record<string, string>, port = freePort()): BuiltServer {
  const child = Bun.spawn([process.execPath, BUILT_SERVER_ENTRY], {
    env: {
      PATH: Bun.env.PATH,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
  ]).then(([stdout, stderr]) => stdout + stderr);
  return { process: child, port, output };
}

/** Polls `/health` until it answers or the process ends. */
export async function waitForHealth(server: BuiltServer): Promise<Response | undefined> {
  const deadline = Date.now() + BUILT_SERVER_BOOT_MS;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${server.port}/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
    } catch {
      if (server.process.exitCode !== null) return undefined;
      await Bun.sleep(50);
    }
  }
  return undefined;
}

/** Kills what is still running and returns the output, printing its tail when the exit was not 0. */
export async function reapBuiltServer(server: BuiltServer): Promise<string> {
  if (server.process.exitCode === null) server.process.kill("SIGKILL");
  await server.process.exited;
  const output = await server.output;
  if (server.process.exitCode !== 0) console.error(output.slice(-4_096));
  return output;
}
