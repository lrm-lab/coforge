import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "../../..");
const helper = join(repoRoot, "scripts/lib/local-web.sh");
const supervisedBun = join(import.meta.dir, "../scripts/supervised-bun.ts");
/** Room for a cold Bun start and a loaded machine. */
const MARGIN_MS = 3_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A port nothing listens on right now. */
async function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  return port;
}

async function sh(script: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(["sh", "-c", script], {
    cwd: repoRoot,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Resolves once `stream` has written `line`; rejects if the stream ends first. */
async function untilLine(stream: ReadableStream<Uint8Array>, line: string) {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    output += decoder.decode(chunk, { stream: true });
    if (output.split("\n").includes(line)) return;
  }
  throw new Error(`stream ended before "${line}": ${output}`);
}

test("prepare_local_web_runtime finds bun when PATH does not include it", async () => {
  const result = await sh(
    `. "${helper}" && prepare_local_web_runtime test && command -v bun && bun --version`,
    { PATH: "/usr/bin:/bin" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1.");
});

test("replace_listener_on_port stops the process holding that port", async () => {
  const port = await freePort();

  // `Bun.serve` returns once the socket is listening, so the holder announces readiness right
  // after it; waiting on that line (not a fixed sleep) keeps the test correct under load.
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch() { return new Response("old"); } }); console.log("listening");`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  await untilLine(holder.stdout, "listening");

  const before = await Bun.fetch(`http://127.0.0.1:${port}/`);
  expect(before.status).toBe(200);
  expect(await before.text()).toBe("old");

  const result = await sh(`. "${helper}" && replace_listener_on_port test ${port}`);
  expect(result.exitCode).toBe(0);
  expect(await holder.exited).not.toBe(null);

  const replacement = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch() {
      return new Response("new");
    },
  });
  const after = await Bun.fetch(`http://127.0.0.1:${port}/`);
  expect(await after.text()).toBe("new");
  await replacement.stop(true);
});

test("a supervised server that closes its port on SIGTERM and keeps running is still stopped", async () => {
  // A Nitro server that has served requests does this. replace_listener_on_port signals the
  // server, not its launcher, which waits for it.
  const graceMs = 200;
  const root = await mkdtemp(join(tmpdir(), "replace-listener-"));
  let launcher: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
  let server: number | undefined;
  try {
    const port = await freePort();
    const pidFile = join(root, "server.pid");
    await writeFile(
      join(root, "server.ts"),
      `const server = Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("old") });\n` +
        `process.on("SIGTERM", () => server.stop());\n` +
        `setInterval(() => {}, 60_000);\n` +
        `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `console.log("listening");\n`,
    );
    await writeFile(
      join(root, "launcher.ts"),
      `import { runSupervisedBun } from ${JSON.stringify(supervisedBun)};\n` +
        `process.exit(await runSupervisedBun([${JSON.stringify(join(root, "server.ts"))}], { cwd: ${JSON.stringify(root)}, env: process.env, stopGraceMs: ${graceMs} }));\n`,
    );
    launcher = Bun.spawn([process.execPath, join(root, "launcher.ts")], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    await untilLine(launcher.stdout, "listening");
    server = Number(await Bun.file(pidFile).text());

    const result = await sh(`. "${helper}" && replace_listener_on_port test ${port}`);
    expect(result.exitCode).toBe(0);
    const exited = await Promise.race([
      launcher.exited.then(() => true),
      Bun.sleep(graceMs + MARGIN_MS).then(() => false),
    ]);
    expect(exited).toBe(true);
    expect(alive(server)).toBe(false);
  } finally {
    launcher?.kill(9);
    if (server !== undefined && alive(server)) process.kill(server, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
