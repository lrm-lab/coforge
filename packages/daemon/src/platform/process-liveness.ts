import { readFileSync } from "node:fs";
import { isExitedProcState, parseProcStat } from "./linux-process-table";

type PidProbeOptions = {
  platform?: NodeJS.Platform;
  probe?: (pid: number) => void;
  readStat?: (path: string) => string;
  probeError?: "alive" | "throw";
};

export function isPidAlive(
  pid: number,
  {
    platform = process.platform,
    probe = (pid) => process.kill(pid, 0),
    readStat = (path) => readFileSync(path, "utf8"),
    probeError,
  }: PidProbeOptions = {},
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid);
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    if (probeError === "throw") throw error;
    if (probeError !== "alive") return false;
  }
  if (platform !== "linux") return true;
  try {
    const stat = parseProcStat(readStat(`/proc/${pid}/stat`));
    return !isExitedProcState(stat?.state);
  } catch {
    return true;
  }
}
