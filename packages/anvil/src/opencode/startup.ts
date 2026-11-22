import { readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AcpTimeoutError } from "#src/acp/connection";
import { AgentProcessCleanupError } from "#src/contract";
import type { JsonlProcess } from "#src/jsonl-process";

type StartupQueue = {
  waiters: Set<() => void>;
  unconfirmedProcess?: JsonlProcess;
  checking?: boolean;
};

const queues = new Map<string, StartupQueue>();

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
  const key = await canonicalPath(resolve(cwd, data, "opencode", database));
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function release(key: string, queue: StartupQueue) {
  const next = queue.waiters.values().next().value;
  if (next) next();
  else queues.delete(key);
}

async function confirmExit(key: string, queue: StartupQueue) {
  const process = queue.unconfirmedProcess;
  if (!process || queue.checking) return;
  queue.checking = true;
  try {
    while (queue.waiters.size) {
      if (await process.waitForOwnedTreeExit(250).catch(() => false)) {
        queue.unconfirmedProcess = undefined;
        release(key, queue);
        return;
      }
      await Bun.sleep(250);
    }
  } finally {
    queue.checking = false;
  }
}

async function takeStartupSlot(key: string, timeoutMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const queue = queues.get(key);
  if (!queue) {
    const acquired: StartupQueue = { waiters: new Set() };
    queues.set(key, acquired);
    return acquired;
  }
  await new Promise<void>((resolve, reject) => {
    const leave = () => {
      queue.waiters.delete(enter);
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
    queue.waiters.add(enter);
    signal?.addEventListener("abort", cancel, { once: true });
    void confirmExit(key, queue);
  });
  return queue;
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
    if (key !== undefined && queue) {
      if (queue.unconfirmedProcess) void confirmExit(key, queue);
      else release(key, queue);
    }
  }
}
