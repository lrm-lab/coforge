import { readFile } from "node:fs/promises";
import type { SupportedStatusPlatform } from "./types";

export type ProcessMemorySample = {
  rssBytes: number;
  swapBytes?: number;
};

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export const HIGH_PROCESS_RSS_BYTES = 2 * GIB;
export const HIGH_PROCESS_SWAP_BYTES = 512 * MIB;

const PS_TIMEOUT_MS = 2_000;
const PROC_RSS_PATTERN = /^VmRSS:\s*(\d+)\s*kB$/m;
const PROC_SWAP_PATTERN = /^VmSwap:\s*(\d+)\s*kB$/m;

export function parseLinuxProcStatusMemory(content: string): ProcessMemorySample | undefined {
  const rssMatch = PROC_RSS_PATTERN.exec(content);
  if (!rssMatch) return undefined;
  const rssKb = Number(rssMatch[1]);
  if (!Number.isSafeInteger(rssKb) || rssKb < 0) return undefined;
  const swapMatch = PROC_SWAP_PATTERN.exec(content);
  const swapKb = swapMatch ? Number(swapMatch[1]) : undefined;
  const swapBytes =
    swapKb !== undefined && Number.isSafeInteger(swapKb) && swapKb >= 0 ? swapKb * KIB : undefined;
  return {
    rssBytes: rssKb * KIB,
    ...(swapBytes !== undefined ? { swapBytes } : {}),
  };
}

export function parsePsRssOutput(output: string): ProcessMemorySample | undefined {
  const trimmed = output.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const rssKb = Number(trimmed);
  if (!Number.isSafeInteger(rssKb) || rssKb < 0) return undefined;
  return { rssBytes: rssKb * KIB };
}

export function formatMemoryBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MiB`;
  return `${Math.round(bytes / KIB)} KiB`;
}

export function formatMemorySummary(memory: ProcessMemorySample): string {
  const rss = `${formatMemoryBytes(memory.rssBytes)} RSS`;
  if (memory.swapBytes !== undefined && memory.swapBytes > 0) {
    return `${rss} (${formatMemoryBytes(memory.swapBytes)} swap)`;
  }
  return rss;
}

export function isProcessMemoryHigh(memory: ProcessMemorySample): boolean {
  if (memory.rssBytes >= HIGH_PROCESS_RSS_BYTES) return true;
  if (memory.swapBytes !== undefined && memory.swapBytes >= HIGH_PROCESS_SWAP_BYTES) return true;
  return false;
}

export async function sampleProcessMemory(
  pid: number,
  options: {
    platform?: SupportedStatusPlatform;
    readProcStatus?: (pid: number) => Promise<string>;
    readPsRss?: (pid: number) => Promise<string>;
  } = {},
): Promise<ProcessMemorySample | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const platform = options.platform ?? (process.platform as SupportedStatusPlatform);
  if (platform === "linux") {
    try {
      const text = options.readProcStatus
        ? await options.readProcStatus(pid)
        : await readFile(`/proc/${pid}/status`, "utf8");
      return parseLinuxProcStatusMemory(text);
    } catch {
      return undefined;
    }
  }
  if (platform === "darwin") {
    try {
      const output = options.readPsRss ? await options.readPsRss(pid) : await readDarwinPsRss(pid);
      return output !== undefined ? parsePsRssOutput(output) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readDarwinPsRss(pid: number): Promise<string | undefined> {
  const child = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(pid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {}
  }, PS_TIMEOUT_MS);
  timer.unref?.();
  try {
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (timedOut || code !== 0) return undefined;
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
