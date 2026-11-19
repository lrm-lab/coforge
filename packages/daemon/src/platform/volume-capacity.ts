import { statfs } from "node:fs/promises";

export type VolumeCapacity = Readonly<{
  availableBytes: number;
  totalBytes: number;
}>;

export type ReadVolumeCapacityOptions = Readonly<{
  platform?: NodeJS.Platform;
  readStatfs?: (path: string) => Promise<VolumeCapacity | undefined>;
  readMacosImportantBytes?: (path: string) => Promise<number | undefined>;
}>;

const MACOS_IMPORTANT_CAPACITY_TIMEOUT_MS = 5_000;
const MACOS_IMPORTANT_CAPACITY_JXA = [
  'ObjC.import("Foundation");',
  "function run(argv) {",
  "  if (!argv || argv.length === 0) return '';",
  "  var url = $.NSURL.fileURLWithPath(argv[0]);",
  "  var ref = Ref();",
  "  if (!url.getResourceValueForKeyError(ref, $.NSURLVolumeAvailableCapacityForImportantUsageKey, null)) return '';",
  "  var val = ObjC.unwrap(ref[0]);",
  "  return typeof val === 'number' && isFinite(val) && val >= 0 ? String(Math.floor(val)) : '';",
  "}",
].join("\n");

const inFlightImportantProbes = new Map<string, Promise<number | undefined>>();

export function parseMacosImportantCapacityOutput(output: string): number | undefined {
  const trimmed = output.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const bytes = Number(trimmed);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  return bytes;
}

async function runMacosImportantCapacityProbe(
  path: string,
  timeoutMs: number,
): Promise<number | undefined> {
  try {
    const child = Bun.spawn({
      cmd: [
        "/usr/bin/osascript",
        "-l",
        "JavaScript",
        "-e",
        MACOS_IMPORTANT_CAPACITY_JXA,
        "--",
        path,
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    timer.unref?.();
    try {
      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      if (exitCode !== 0) return undefined;
      return parseMacosImportantCapacityOutput(stdout);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

export function readMacosImportantAvailableBytes(
  path: string,
  timeoutMs = MACOS_IMPORTANT_CAPACITY_TIMEOUT_MS,
): Promise<number | undefined> {
  if (!path) return Promise.resolve(undefined);
  const existing = inFlightImportantProbes.get(path);
  if (existing) return existing;
  const probe = runMacosImportantCapacityProbe(path, timeoutMs).finally(() => {
    if (inFlightImportantProbes.get(path) === probe) inFlightImportantProbes.delete(path);
  });
  inFlightImportantProbes.set(path, probe);
  return probe;
}

async function readHostStatfs(path: string): Promise<VolumeCapacity | undefined> {
  try {
    const info = await statfs(path);
    const availableBytes = Number(info.bavail) * Number(info.bsize);
    const totalBytes = Number(info.blocks) * Number(info.bsize);
    if (
      !Number.isSafeInteger(availableBytes) ||
      !Number.isSafeInteger(totalBytes) ||
      availableBytes < 0 ||
      totalBytes <= 0 ||
      availableBytes > totalBytes
    )
      return undefined;
    return { availableBytes, totalBytes };
  } catch {
    return undefined;
  }
}

export function mergeImportantAvailableBytes(
  base: VolumeCapacity,
  importantBytes: number | undefined,
): VolumeCapacity {
  if (
    importantBytes === undefined ||
    !Number.isSafeInteger(importantBytes) ||
    importantBytes <= base.availableBytes
  )
    return base;
  return {
    availableBytes: Math.min(base.totalBytes, importantBytes),
    totalBytes: base.totalBytes,
  };
}

export async function readVolumeCapacity(
  path: string,
  options: ReadVolumeCapacityOptions = {},
): Promise<VolumeCapacity | undefined> {
  const base = await (options.readStatfs ?? readHostStatfs)(path);
  if (!base) return undefined;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return base;
  const readImportant = options.readMacosImportantBytes ?? readMacosImportantAvailableBytes;
  const importantBytes = await readImportant(path).catch(() => undefined);
  return mergeImportantAvailableBytes(base, importantBytes);
}
