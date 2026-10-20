/**
 * Lists the local Web servers on this machine (a built Nitro server, `.output/server/index.mjs`, or
 * `vite dev`, from any checkout's apps/web) and stops the stale ones by exact pid:
 *
 *   bun run --cwd apps/web local-servers list
 *   bun run --cwd apps/web local-servers stop --stale
 *
 * Only servers of CoForge's own Web package count: another project can have an `apps/web`, and a
 * Nuxt build is `.output/server/index.mjs` too. A server from a deleted checkout counts only when
 * it carries its launcher's preload. A server is stale when its checkout is gone, or when it has
 * listened on no port past its first minute with no launcher left waiting for it. An orphaned one
 * (its launcher ended, as before supervised-bun.ts) is reported but kept while it still listens:
 * someone may be using it. Uses `ps` and `lsof`, on macOS and Linux. When `lsof` shows no
 * listening socket at all, every server would look idle, so nothing is stopped.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import webPackage from "../package.json";
import { LAUNCHER_PRELOAD } from "./launcher-contract";

export type PsRow = {
  pid: number;
  ppid: number;
  rssKb: number;
  ageSeconds: number;
  command: string;
};

export type LocalServer = {
  pid: number;
  /** The server and every process under it: what stopping it means. */
  pids: number[];
  /** The start-server / start-web / dev:hmr process that runs it, while it is alive. */
  launcher: number | undefined;
  kind: "nitro" | "vite";
  webRoot: string;
  rssKb: number;
  ageSeconds: number;
  ports: number[];
  /** Re-parented to PID 1: nothing will stop it when its session ends. */
  orphaned: boolean;
  /** Why it is stale; empty when it is not. */
  stale: string[];
};

export type ServerFacts = {
  cwd(pid: number): string | undefined;
  exists(path: string): boolean;
  /** The `name` in `<webRoot>/package.json`. */
  webPackage(webRoot: string): string | undefined;
  listening(pid: number): number[];
};

const LAUNCHER = /scripts\/(start-server|start-web|dev-web-hmr)\.ts\b/;
/** The checkout a command names, absolute or relative to the process's cwd. */
const CHECKOUT =
  /((?:\S*\/)?apps\/web)\/(?:\.output\/server\/index\.mjs|scripts\/exit-with-launcher\.ts|node_modules\/)/;
/** A server still starting has not opened its port yet. */
const STARTUP_GRACE_SECONDS = 60;
export const STOP_GRACE_MS = 5_000;
const CANNOT_SEE_SOCKETS = "cannot see listening sockets";

/** `ps` etime: `[[dd-]hh:]mm:ss`. */
function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const [seconds = 0, minutes = 0, hours = 0] = clock!.split(":").map(Number).reverse();
  return Number(days) * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/** Every process in `ps -axo pid=,ppid=,rss=,etime=,command=` output. */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const command = match[5]!.trim();
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      ageSeconds: elapsedSeconds(match[4]!),
      command,
    });
  }
  return rows;
}

/** Each pid's listening TCP ports in `lsof -iTCP -sTCP:LISTEN -P -n -Fpn` output. */
export function parseListening(output: string): Map<number, number[]> {
  const ports = new Map<number, Set<number>>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n") || pid === undefined) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) ports.set(pid, (ports.get(pid) ?? new Set()).add(port));
  }
  return new Map([...ports].map(([owner, set]) => [owner, [...set].sort((a, b) => a - b)]));
}

// Only a bun or node executable runs a server; a shell or pager merely naming one does not.
const RUNTIME = /^\S*\b(?:bun|node)\s/;
const isVite = (row: PsRow) =>
  RUNTIME.test(row.command) && /\bvite(?:\/bin\/vite\.js)? dev\b/.test(row.command);
const isNitro = (row: PsRow) =>
  /^\S*\bbun\s/.test(row.command) &&
  /(?:^|\s)(?:\S*\/)?\.output\/server\/index\.mjs(?:\s|$)/.test(row.command);

export function classifyServers(rows: PsRow[], facts: ServerFacts): LocalServer[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map<number, PsRow[]>();
  // A process that is its own parent (pid 0 on some systems) would make the tree endless.
  for (const row of rows) {
    if (row.pid !== row.ppid) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }
  const subtree = (row: PsRow): PsRow[] => [row, ...(children.get(row.pid) ?? []).flatMap(subtree)];
  const servers: LocalServer[] = [];
  for (const row of rows) {
    const parent = byPid.get(row.ppid);
    // `bun --bun vite dev` starts Vite as a node child; the wrapper stands for both.
    if (!(isNitro(row) || isVite(row)) || (parent && isVite(parent))) continue;
    const kind: LocalServer["kind"] = isNitro(row) ? "nitro" : "vite";
    const named = row.command.match(CHECKOUT)?.[1];
    let webRoot = named;
    if (!named?.startsWith("/")) {
      const cwd = facts.cwd(row.pid);
      if (!cwd) continue;
      webRoot = named ? resolve(cwd, named) : cwd;
    }
    // Linux lsof marks a removed cwd ` (deleted)`, so it is no checkout either.
    if (!webRoot?.endsWith("/apps/web")) continue;
    const deleted = !facts.exists(webRoot);
    const ours = deleted
      ? row.command.includes(` --preload ${webRoot}/scripts/${LAUNCHER_PRELOAD} `)
      : facts.webPackage(webRoot) === webPackage.name;
    if (!ours) continue;
    const launcher = parent && LAUNCHER.test(parent.command) ? parent.pid : undefined;
    const tree = subtree(row);
    const ports = [...new Set(tree.flatMap((process) => facts.listening(process.pid)))].sort(
      (a, b) => a - b,
    );
    const stale: string[] = [];
    if (deleted) stale.push("checkout deleted");
    // A launcher still waiting for its server (on Postgres, say) stops it itself.
    if (ports.length === 0 && row.ageSeconds >= STARTUP_GRACE_SECONDS && launcher === undefined) {
      stale.push("not listening");
    }
    servers.push({
      pid: row.pid,
      pids: tree.map((process) => process.pid),
      launcher,
      kind,
      webRoot,
      rssKb: tree.reduce((sum, process) => sum + process.rssKb, 0),
      ageSeconds: row.ageSeconds,
      ports,
      orphaned: row.ppid === 1,
      stale,
    });
  }
  return servers;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** False when the pid is gone (ESRCH) or not this user's (EPERM). */
const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
};

/**
 * Sends SIGTERM to each target, then SIGKILL to those still running after `graceMs`, each time
 * only while `commands()` still shows the pid running the same command: a pid freed since it was
 * listed may have been reused. Resolves with the pids that were sent SIGTERM.
 */
export async function stopExactly(
  targets: { pid: number; command: string }[],
  commands: () => Map<number, string>,
  graceMs: number,
): Promise<number[]> {
  const unchanged = (running: Map<number, string>, target: { pid: number; command: string }) =>
    running.get(target.pid) === target.command;
  const listed = commands();
  const signalled = targets.filter(
    (target) => unchanged(listed, target) && signal(target.pid, "SIGTERM"),
  );
  const deadline = Date.now() + graceMs;
  while (signalled.some((target) => isAlive(target.pid)) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  const running = commands();
  for (const target of signalled) {
    if (unchanged(running, target)) signal(target.pid, "SIGKILL");
  }
  return signalled.map((target) => target.pid);
}

function run(cmd: string[]): { ok: boolean; stdout: string } {
  try {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    return { ok: result.success, stdout: result.stdout.toString() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

const readPs = () => parsePs(run(["ps", "-axww", "-o", "pid=,ppid=,rss=,etime=,command="]).stdout);

/** Every listening socket on the machine, or undefined when lsof shows none (or failed). */
function readListening(): Map<number, number[]> | undefined {
  const result = run(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fpn"]);
  const listening = parseListening(result.stdout);
  return result.ok && listening.size > 0 ? listening : undefined;
}

const machineFacts = (listening: Map<number, number[]> | undefined): ServerFacts => ({
  cwd: (pid) =>
    run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
      .stdout.split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1),
  exists: existsSync,
  webPackage: (webRoot) => {
    try {
      return JSON.parse(readFileSync(resolve(webRoot, "package.json"), "utf8")).name;
    } catch {
      return undefined;
    }
  },
  listening: (pid) => listening?.get(pid) ?? [],
});

function describe(server: LocalServer): string {
  const age = `${Math.floor(server.ageSeconds / 3_600)}h${Math.floor((server.ageSeconds % 3_600) / 60)}m`;
  const ports = server.ports.length > 0 ? server.ports.join(",") : "-";
  const state =
    (server.stale.length > 0 ? `stale: ${server.stale.join(", ")}` : "live") +
    (server.orphaned ? " (orphaned)" : "");
  const launcher = server.launcher ? ` launcher ${server.launcher}` : "";
  return `${server.pid}${launcher}  ${server.kind}  ${Math.round(server.rssKb / 1024)}MB  ${age}  ports ${ports}  ${state}  ${server.webRoot}`;
}

async function main(argv: string[]): Promise<number> {
  const rows = readPs();
  const listening = readListening();
  const servers = classifyServers(rows, machineFacts(listening));
  if (argv[0] === "list") {
    if (!listening) console.error(`${CANNOT_SEE_SOCKETS}; ports and "not listening" are unknown`);
    for (const server of servers) console.log(describe(server));
    const megabytes = Math.round(servers.reduce((sum, server) => sum + server.rssKb, 0) / 1024);
    console.log(
      `${servers.length} local Web servers, ${megabytes}MB; ${servers.filter((server) => server.stale.length > 0).length} stale`,
    );
    return 0;
  }
  if (argv[0] === "stop" && argv[1] === "--stale") {
    if (!listening) {
      console.error(`${CANNOT_SEE_SOCKETS}; not stopping anything`);
      return 1;
    }
    const command = new Map(rows.map((row) => [row.pid, row.command]));
    // The launcher first, then the server and what it started (Vite's node child).
    const targets = servers
      .filter((server) => server.stale.length > 0)
      .flatMap((server) => [...(server.launcher ? [server.launcher] : []), ...server.pids])
      .map((pid) => ({ pid, command: command.get(pid)! }));
    const stopped = await stopExactly(
      targets,
      () => new Map(readPs().map((row) => [row.pid, row.command])),
      STOP_GRACE_MS,
    );
    console.log(stopped.length > 0 ? `stopped ${stopped.join(" ")}` : "no stale local Web servers");
    return 0;
  }
  console.error("usage: local-servers list | local-servers stop --stale");
  return 2;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
