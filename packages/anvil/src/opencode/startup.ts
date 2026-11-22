import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { mkdir, mkdtemp, readlink, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AcpTimeoutError } from "#src/acp/connection";
import { AgentProcessCleanupError } from "#src/contract";
import type { JsonlProcess } from "#src/jsonl-process";

type StartupQueue = {
  path: string;
  waiters: Set<() => void>;
  unconfirmedProcess?: JsonlProcess;
  checking?: boolean;
};

const queues = new Map<string, Map<string, StartupQueue>>();

function foldedPath(path: string) {
  return path.normalize("NFD").toLowerCase().toUpperCase().normalize("NFC");
}

async function canonicalPath(path: string, links = new Set<string>()): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    const directory = await canonicalPath(parent, links);
    const target = await readlink(path).catch((linkError: NodeJS.ErrnoException) => {
      if (linkError.code !== "ENOENT" && linkError.code !== "EINVAL") throw linkError;
    });
    if (target === undefined) return join(directory, basename(path));
    if (links.has(path)) throw error;
    links.add(path);
    return canonicalPath(resolve(directory, target), links);
  }
}

async function databaseKey(cwd: string, environment: Readonly<Record<string, string | undefined>>) {
  const database = environment.OPENCODE_DB ?? "opencode.db";
  if (database === ":memory:") return undefined;
  const home =
    (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || homedir();
  const data = environment.XDG_DATA_HOME || join(home, ".local", "share");
  return canonicalPath(resolve(cwd, data, RUNTIME_PROVIDER.OPENCODE, database));
}

async function makeNameProbe(directory: string): Promise<string> {
  try {
    return await mkdtemp(join(directory, "coforge-opencode-name-"));
  } catch (error) {
    const parent = dirname(directory);
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && parent !== directory)
      return makeNameProbe(parent);
    throw error;
  }
}

async function sameFilesystemName(first: string, second: string): Promise<boolean> {
  let common = dirname(first);
  while (!second.startsWith(common.endsWith(sep) ? common : common + sep)) {
    const parent = dirname(common);
    if (parent === common) return true;
    common = parent;
  }
  const probe = await makeNameProbe(common);
  try {
    const firstPath = join(probe, relative(dirname(probe), first));
    const secondPath = join(probe, relative(dirname(probe), second));
    await mkdir(firstPath, { recursive: true });
    const existing = await stat(secondPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    return existing !== undefined;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

function release(queue: StartupQueue) {
  const next = queue.waiters.values().next().value;
  if (next) {
    next();
    return;
  }
  const key = foldedPath(queue.path);
  const bucket = queues.get(key);
  bucket?.delete(queue.path);
  if (bucket?.size === 0) queues.delete(key);
}

async function confirmExit(queue: StartupQueue) {
  const process = queue.unconfirmedProcess;
  if (!process || queue.checking) return;
  queue.checking = true;
  try {
    while (queue.waiters.size) {
      if (await process.waitForOwnedTreeExit(250).catch(() => false)) {
        queue.unconfirmedProcess = undefined;
        release(queue);
        return;
      }
      await Bun.sleep(250);
    }
  } finally {
    queue.checking = false;
  }
}

async function takeStartupSlot(
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StartupQueue> {
  signal?.throwIfAborted();
  const key = foldedPath(path);
  const bucket = queues.get(key) ?? new Map<string, StartupQueue>();
  queues.set(key, bucket);
  let queue = bucket.get(path);
  if (!queue) {
    for (const candidate of bucket.values()) {
      const sameName =
        candidate.path === path ||
        (await sameFilesystemName(candidate.path, path).catch(() => true));
      if (queues.get(key) !== bucket) return takeStartupSlot(path, timeoutMs, signal);
      signal?.throwIfAborted();
      if (sameName && bucket.get(candidate.path) === candidate) {
        queue = candidate;
        break;
      }
    }
  }
  if (!queue) {
    const acquired: StartupQueue = { path, waiters: new Set() };
    bucket.set(path, acquired);
    return acquired;
  }
  const waiting = queue;
  await new Promise<void>((resolve, reject) => {
    const leave = () => {
      waiting.waiters.delete(enter);
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const enter = () => {
      leave();
      resolve();
    };
    const cancel = () => {
      leave();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      leave();
      reject(new AcpTimeoutError("opencode acp timed out waiting for database startup"));
    }, timeoutMs);
    waiting.waiters.add(enter);
    signal?.addEventListener("abort", cancel, { once: true });
    void confirmExit(waiting);
  });
  return waiting;
}

export async function runOpenCodeStartup<T>(
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  start: (track: (process: JsonlProcess) => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const key = await databaseKey(cwd, environment);
  const queue = key === undefined ? undefined : await takeStartupSlot(key, timeoutMs, signal);
  let process: JsonlProcess | undefined;
  try {
    signal?.throwIfAborted();
    return await start((child) => {
      process = child;
    });
  } catch (error) {
    if (process?.exitInfo().cleanupUnconfirmed) {
      if (queue) queue.unconfirmedProcess = process;
      if (!(error instanceof AgentProcessCleanupError))
        throw new AgentProcessCleanupError({ cause: error });
    }
    throw error;
  } finally {
    if (queue) {
      if (queue.unconfirmedProcess) void confirmExit(queue);
      else release(queue);
    }
  }
}
