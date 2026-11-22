import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginLocalUpgradeProgress,
  readLocalUpgradeContext,
} from "../src/platform/computer-upgrade-progress";

import { LocalDaemonLauncher } from "../src/daemon-host/launcher";

const scratch: string[] = [];
export async function cleanupFixtures() {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cf-upgrade-"));
  scratch.push(root);
  const installRoot = join(root, "install");
  const stateDirectory = join(root, "daemon");
  await mkdir(installRoot);
  const requestId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const version = "2.0.0";
  await beginLocalUpgradeProgress(installRoot, workspaceId, requestId, version);
  const local = await readLocalUpgradeContext(installRoot, requestId);
  if (!local) throw new Error("progress context missing");
  return { installRoot, stateDirectory, requestId, workspaceId, version, ...local };
}

export function spawnWorkspaceActivation(
  installRoot: string,
  version: string,
  stateDirectory: string,
) {
  const recovery = import.meta.resolve("../src/supervisor/workspace-upgrade-recovery.ts");
  const localRpc = import.meta.resolve("../src/local-rpc.ts");
  return Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const { readWorkspaceUpgradeActivation } = await import(${JSON.stringify(recovery)});
       const { startDaemonLocalRpcServer } = await import(${JSON.stringify(localRpc)});
       const { join } = await import("node:path");
       const [root, version, state] = Bun.argv.slice(-3);
       const binding = await Bun.file(join(state, "config.json")).json();
       const server = await startDaemonLocalRpcServer({
         socketPath: join(state, "daemon.sock"), version, validateCredential: () => false,
         runtime: {}, credentials: {},
       });
       try {
         if (await new Response(Bun.stdin.stream()).text() !== "start") throw new Error("missing fixture start");
         const activation = await readWorkspaceUpgradeActivation(root, state, binding, version, performance.timeOrigin, new AbortController().signal);
         console.log(JSON.stringify(activation ?? null));
       } finally {
         await server.close();
       }`,
      installRoot,
      version,
      stateDirectory,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
}

export async function workspaceActivationResult(
  child: ReturnType<typeof spawnWorkspaceActivation>,
) {
  child.stdin.write("start");
  child.stdin.end();
  const output = await new Response(child.stdout).json();
  expect(await child.exited).toBe(0);
  return output;
}

export async function workspaceIdentity(path: string, processId: number) {
  const launcher = new LocalDaemonLauncher({
    executablePath: process.execPath,
    socketPath: join(path, "daemon.sock"),
    spawn: () => {},
  });
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const identity = await launcher.identity(100).catch(() => undefined);
    if (identity?.processId === processId) return identity;
    await Bun.sleep(25);
  }
  throw new Error("fixture Workspace handshake missing");
}

export function runWorkspaceActivation(installRoot: string, version: string, directory: string) {
  return workspaceActivationResult(spawnWorkspaceActivation(installRoot, version, directory));
}
