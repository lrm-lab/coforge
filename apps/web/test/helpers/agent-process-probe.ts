import { readFileSync } from "node:fs";

export async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for E2E state");
    await Bun.sleep(50);
  }
}

export async function readProcesses(path: string) {
  await waitFor(async () => Bun.file(path).exists());
  return (await Bun.file(path).json()) as {
    directPid: number;
    descendantPid: number;
  };
}

export function pidExists(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    throw error;
  }
}
