import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  COMPUTER_FILE_MAX_BYTES,
  sanitizeComputerFileName,
  type ComputerFilePullRequest,
  type ComputerFilePullResult,
} from "@lrm/coforge-sdk/internal";

export type ComputerFilePullPorts = {
  workspaceRoot: string;
  fetch?(url: string, init: RequestInit): Promise<Response>;
  now?: () => number;
};

/**
 * Downloads one owner-uploaded object into `<workspaceRoot>/uploads/<fileName>`. Writes through a
 * sibling temp file then renames, so a partial download never leaves a final name.
 */
export async function pullComputerFile(
  request: ComputerFilePullRequest,
  ports: ComputerFilePullPorts,
  signal?: AbortSignal,
): Promise<ComputerFilePullResult> {
  const base = {
    ...request,
    path: "",
    errorMessage: "",
  };
  let fileName: string;
  try {
    fileName = sanitizeComputerFileName(request.fileName);
  } catch {
    return { ...base, status: "error", errorMessage: "invalid file name" };
  }
  if (request.sizeBytes > COMPUTER_FILE_MAX_BYTES)
    return { ...base, status: "too_large", errorMessage: "file exceeds computer upload limit" };

  const uploads = join(ports.workspaceRoot, "uploads");
  const destination = join(uploads, fileName);
  const temp = join(
    uploads,
    `.pull-${request.requestId}-${(ports.now ?? Date.now)().toString(36)}.tmp`,
  );
  const fetchImpl = ports.fetch ?? fetch;

  try {
    await mkdir(uploads, { recursive: true });
    const response = await fetchImpl(request.downloadUrl, { method: "GET", signal });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ...base,
        status: response.status >= 500 ? "unavailable" : "error",
        errorMessage: `download refused with ${response.status}`,
      };
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== request.sizeBytes) {
      await response.body?.cancel();
      return {
        ...base,
        status: "error",
        errorMessage: `content-length ${length} != ${request.sizeBytes}`,
      };
    }
    if (!response.body)
      return { ...base, status: "error", errorMessage: "download response has no body" };

    const handle = await open(temp, "w");
    try {
      let written = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        written += value.byteLength;
        if (written > request.sizeBytes || written > COMPUTER_FILE_MAX_BYTES) {
          await reader.cancel();
          throw new Error("download exceeded declared size");
        }
        await handle.write(value);
      }
      if (written !== request.sizeBytes)
        throw new Error(`downloaded ${written} bytes, expected ${request.sizeBytes}`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, destination);
    return { ...base, status: "ok", path: destination };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if (signal?.aborted)
      return { ...base, status: "unavailable", errorMessage: "download aborted" };
    const message = error instanceof Error ? error.message : "download failed";
    return {
      ...base,
      status: message.includes("exceeded") ? "too_large" : "error",
      errorMessage: message.slice(0, 1000),
    };
  }
}
