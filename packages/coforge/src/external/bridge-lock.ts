import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../cli-error";

const LOCK_FILE = "bridge.lock";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const alreadyRunning = (pid: number) =>
  new CliError({
    code: "BRIDGE_ALREADY_RUNNING",
    message: `Another bridge (pid ${pid}) already runs for this profile.`,
    retryable: false,
    suggestedNextAction: "Stop it first, or use a different profile.",
  });

export async function acquireBridgeLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        const holder = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
        if (holder === process.pid) await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw alreadyRunning(holder);
      await rm(path, { force: true });
    }
  }
  throw new CliError({
    code: "BRIDGE_LOCK_FAILED",
    message: "The bridge lock could not be taken.",
    retryable: true,
  });
}
