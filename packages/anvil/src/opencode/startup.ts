import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AcpTimeoutError } from "#src/acp/connection";
import { AgentProcessCleanupError } from "#src/contract";

type StartupWaiter = () => void;
const queues = new Map<string, Set<StartupWaiter>>();

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
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

async function takeStartupSlot(key: string, timeoutMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const queue = queues.get(key);
  if (!queue) {
    queues.set(key, new Set());
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const leave = () => {
      queue.delete(enter);
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
    queue.add(enter);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function runOpenCodeStartup<T>(
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  start: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const key = await databaseKey(cwd, environment);
  if (key !== undefined) await takeStartupSlot(key, timeoutMs, signal);
  let cleanupUnconfirmed = false;
  try {
    signal?.throwIfAborted();
    return await start();
  } catch (error) {
    cleanupUnconfirmed = error instanceof AgentProcessCleanupError;
    throw error;
  } finally {
    if (key !== undefined && !cleanupUnconfirmed) {
      const next = queues.get(key)?.values().next().value;
      if (next) next();
      else queues.delete(key);
    }
  }
}
