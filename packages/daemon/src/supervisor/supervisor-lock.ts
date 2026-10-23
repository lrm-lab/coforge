import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireProcessLock, isLockContention, type ProcessLock } from "#src/platform/process-lock";

/**
 * Takes the Coordinator's lifetime lock, or, when another CoForge Daemon already holds it,
 * raises a message that names the holder and how to clear it instead of letting bun:sqlite's
 * raw "database is locked" reach the person running `foreground`. Exported as its own function
 * so a test can drive real lock contention (two in-process `acquireProcessLock` calls on the
 * same path) without spawning a second process.
 */
export async function acquireSupervisorLock(stateDirectory: string): Promise<ProcessLock> {
  const lockPath = join(stateDirectory, "supervisor-lock.sqlite");
  try {
    return acquireProcessLock(lockPath);
  } catch (error) {
    if (!isLockContention(error)) throw error;
    // Keeps SQLite's own code on the cause, so the technical reason survives for anyone reading
    // a stack trace while the message stays the one a person can act on.
    throw new Error(await describeSupervisorLockHeld(stateDirectory, lockPath), { cause: error });
  }
}

async function describeSupervisorLockHeld(
  stateDirectory: string,
  lockPath: string,
): Promise<string> {
  const ownerPid = await readSupervisorLockOwnerPid(stateDirectory);
  const holder = ownerPid !== null ? ` (pid ${ownerPid})` : "";
  return [
    `Another CoForge Daemon is already running on this Computer${holder} and holds the supervisor lock at ${lockPath}.`,
    "Run `coforge-computer status` to see it, then `coforge-computer stop` before running `foreground` again.",
  ].join("\n");
}

/** Best-effort: the owner file is written by the process that currently holds the lock
 * (`runWithSupervisorLock` in run-supervisor.ts), so a missing or unreadable file means only that the pid
 * cannot be shown, never that the lock itself is free — the caller already knows it is held. */
async function readSupervisorLockOwnerPid(stateDirectory: string): Promise<number | null> {
  try {
    const text = (await readFile(join(stateDirectory, "supervisor.lock", "owner"), "utf8")).trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
