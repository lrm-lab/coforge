import { mkdtemp, readlink, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AcpTimeoutError } from "#src/acp/connection";
import { AgentProcessCleanupError } from "#src/contract";
import type { JsonlProcess } from "#src/jsonl-process";

type StartupQueue = {
  path: string;
  waiters: Set<() => void>;
  unconfirmedProcess?: JsonlProcess;
  checking?: boolean;
};

type StartupQueues = {
  paths: Map<string, StartupQueue>;
  caseSensitive?: Promise<boolean>;
};

const queues = new Map<string, StartupQueues>();

function foldedPath(path: string) {
  return path.normalize("NFC").toLowerCase();
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
  return canonicalPath(resolve(cwd, data, "opencode", database));
}

async function isCaseSensitive(directory: string): Promise<boolean> {
  let probe: string;
  try {
    probe = await mkdtemp(join(directory, "coforge-opencode-case-"));
  } catch (error) {
    const parent = dirname(directory);
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && parent !== directory)
      return isCaseSensitive(parent);
    throw error;
  }
  try {
    const actual = await stat(probe);
    const folded = await stat(join(dirname(probe), basename(probe).toUpperCase())).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    return folded === undefined || actual.dev !== folded.dev || actual.ino !== folded.ino;
  } finally {
    await rmdir(probe);
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
  bucket?.paths.delete(queue.path);
  if (bucket?.paths.size === 0) queues.delete(key);
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
  const bucket: StartupQueues = queues.get(key) ?? { paths: new Map<string, StartupQueue>() };
  queues.set(key, bucket);
  let queue = bucket.paths.get(path);
  if (!queue && bucket.paths.size) {
    const caseSensitive = await (bucket.caseSensitive ??= isCaseSensitive(dirname(path)).catch(
      () => false,
    ));
    if (queues.get(key) !== bucket) return takeStartupSlot(path, timeoutMs, signal);
    signal?.throwIfAborted();
    queue = bucket.paths.get(path);
    if (!caseSensitive) queue ??= bucket.paths.values().next().value;
  }
  if (!queue) {
    const acquired: StartupQueue = { path, waiters: new Set() };
    bucket.paths.set(path, acquired);
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
