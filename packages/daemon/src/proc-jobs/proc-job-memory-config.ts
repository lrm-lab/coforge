import { isRecord } from "@lrm/coforge-sdk/internal";
import { ProcJobError } from "./proc-job-error";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MEMORY_MAX_MB = 4096;

export async function readProcJobMemoryLimit(path: string): Promise<number> {
  try {
    const config: unknown = await Bun.file(path).json();
    if (!isRecord(config)) throw new Error();
    const value = config.memoryMaxMb === undefined ? DEFAULT_MEMORY_MAX_MB : config.memoryMaxMb;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
    const bytes = value * MEBIBYTE;
    if (!Number.isSafeInteger(bytes)) throw new Error();
    return bytes;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return DEFAULT_MEMORY_MAX_MB * MEBIBYTE;
    throw new ProcJobError(
      "proc_invalid_request",
      400,
      "Invalid or unreadable Computer proc memory configuration.",
    );
  }
}
