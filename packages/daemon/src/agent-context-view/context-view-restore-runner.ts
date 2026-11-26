import type { FileHandle } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import {
  restoreContextView,
  type RestoreRequest,
  type ContextViewRestoreResult,
} from "./context-view-restore";

export const CONTEXT_VIEW_RESTORE_TIMEOUT_MS = 25_000;
export const CONTEXT_VIEW_RESTORE_HEAP_MB = 1_024;
export const CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES = 64 * 1024;
export const CONTEXT_VIEW_RESTORE_RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES = 512 * 1024 * 1024;
export const CONTEXT_VIEW_RESTORE_RSS_MAX_BYTES = 1_024 * 1024 * 1024;
export const CONTEXT_VIEW_RESTORE_INPUT_FRAME_MAX_BYTES =
  Math.ceil((CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES * 4) / 3) + CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES;

const STREAM_CHUNK_BYTES = 256 * 1024;

type ChildRequest = Omit<RestoreRequest, "buffer"> & { bufferBase64: string };
type ChildStreamHeader = Omit<RestoreRequest, "buffer"> & { version: 2 };
type ChildHeader = { version: 1; outcome: "ok" | "failed"; bytes: number };

export type RestoreFileRequest = Omit<RestoreRequest, "buffer"> & {
  handle: FileHandle;
  maxSourceBytes?: number;
};

function encodeStreamHeader(request: Omit<RestoreRequest, "buffer">): string {
  const header: ChildStreamHeader = {
    version: 2,
    runtime: request.runtime,
    sessionId: request.sessionId,
    messageId: request.messageId,
    offset: request.offset,
    ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
  };
  return `${JSON.stringify(header)}\n`;
}

function decodeChildInput(combined: Buffer): RestoreRequest | { tooLarge: true } {
  const headerSearchLimit = Math.min(
    combined.byteLength,
    CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES + 1,
  );
  const newline = combined.indexOf(0x0a);
  if (newline >= 0 && newline < headerSearchLimit) {
    try {
      const parsed = JSON.parse(
        combined.subarray(0, newline).toString("utf8"),
      ) as Partial<ChildStreamHeader>;
      if (parsed && parsed.version === 2) {
        const buffer = combined.subarray(newline + 1);
        if (buffer.byteLength > CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES) return { tooLarge: true };
        return {
          runtime: parsed.runtime!,
          sessionId: parsed.sessionId!,
          messageId: parsed.messageId!,
          offset: parsed.offset!,
          ...(parsed.maxBytes !== undefined ? { maxBytes: parsed.maxBytes } : {}),
          buffer,
        };
      }
    } catch {
      void 0;
    }
  }
  const request = JSON.parse(combined.toString("utf8")) as ChildRequest;
  const buffer = Buffer.from(request.bufferBase64, "base64");
  if (buffer.byteLength > CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES) return { tooLarge: true };
  return {
    runtime: request.runtime,
    sessionId: request.sessionId,
    messageId: request.messageId,
    offset: request.offset,
    ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
    buffer,
  };
}

const EMBEDDED_SCRIPT_PREFIX = "/$bunfs/";

export function selfSubcommand(
  subcommand: string,
  self: Readonly<{ execPath: string; script?: string }> = {
    execPath: process.execPath,
    script: process.argv[1],
  },
): string[] {
  const embedded = self.script?.startsWith(EMBEDDED_SCRIPT_PREFIX) === true;
  const script = self.script !== undefined && !embedded ? [self.script] : [];
  return [self.execPath, ...script, subcommand];
}

export function encodeContextViewRestoreChildResult(result: ContextViewRestoreResult): string {
  const payload = JSON.stringify(result);
  const bytes = Buffer.byteLength(payload, "utf8");
  const header: ChildHeader = { version: 1, outcome: result.ok ? "ok" : "failed", bytes };
  return `${JSON.stringify(header)}\n${payload}`;
}

export function decodeContextViewRestoreChildResult(raw: string): ContextViewRestoreResult {
  const newline = raw.indexOf("\n");
  if (
    newline < 0 ||
    Buffer.byteLength(raw.slice(0, newline), "utf8") > CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES
  )
    return { ok: false, failure: "read_failed" };
  let header: ChildHeader;
  try {
    header = JSON.parse(raw.slice(0, newline)) as ChildHeader;
  } catch {
    return { ok: false, failure: "read_failed" };
  }
  const payload = raw.slice(newline + 1);
  if (
    header.version !== 1 ||
    !Number.isSafeInteger(header.bytes) ||
    header.bytes < 0 ||
    header.bytes > CONTEXT_VIEW_RESTORE_RESULT_MAX_BYTES ||
    Buffer.byteLength(payload, "utf8") !== header.bytes
  )
    return {
      ok: false,
      failure: header.bytes > CONTEXT_VIEW_RESTORE_RESULT_MAX_BYTES ? "too_large" : "read_failed",
      ...(header.bytes > CONTEXT_VIEW_RESTORE_RESULT_MAX_BYTES
        ? { tooLargeCause: "request" as const }
        : {}),
    };
  try {
    const result = JSON.parse(payload) as ContextViewRestoreResult;
    return result.ok === true || result.ok === false
      ? result
      : { ok: false, failure: "read_failed" };
  } catch {
    return { ok: false, failure: "read_failed" };
  }
}

export async function runContextViewRestoreChildMain(
  input: AsyncIterable<Uint8Array> = Bun.stdin.stream(),
): Promise<void> {
  if (process.platform === "linux") {
    try {
      writeFileSync("/proc/self/oom_score_adj", "1000");
    } catch {
      void 0;
    }
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > CONTEXT_VIEW_RESTORE_INPUT_FRAME_MAX_BYTES) {
      process.stdout.write(
        encodeContextViewRestoreChildResult({
          ok: false,
          failure: "too_large",
          tooLargeCause: "session_file",
        }),
      );
      return;
    }
    chunks.push(chunk);
  }
  const combined = Buffer.concat(chunks, bytes);
  const decoded = decodeChildInput(combined);
  if ("tooLarge" in decoded) {
    process.stdout.write(
      encodeContextViewRestoreChildResult({
        ok: false,
        failure: "too_large",
        tooLargeCause: "session_file",
      }),
    );
    return;
  }
  const result =
    process.memoryUsage().rss > CONTEXT_VIEW_RESTORE_RSS_MAX_BYTES
      ? {
          ok: false as const,
          failure: "too_large" as const,
          tooLargeCause: "restore_limit" as const,
        }
      : restoreContextView(decoded);
  process.stdout.write(encodeContextViewRestoreChildResult(result));
}

function spawnRestoreChild(options: { command?: string[] }) {
  const command = options.command ?? selfSubcommand("__restore-context-view");
  return Bun.spawn({
    cmd: command,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: CONTEXT_VIEW_RESTORE_RESULT_MAX_BYTES + CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES,
    ...(process.execPath.endsWith("bun")
      ? {
          env: {
            ...process.env,
            NODE_OPTIONS: `--max-old-space-size=${CONTEXT_VIEW_RESTORE_HEAP_MB}`,
          },
        }
      : {}),
  });
}

async function finishRestoreChild(
  child: ReturnType<typeof spawnRestoreChild>,
  stderr: Promise<string>,
): Promise<ContextViewRestoreResult> {
  const [raw] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (
    Buffer.byteLength(raw, "utf8") >
    CONTEXT_VIEW_RESTORE_RESULT_MAX_BYTES + CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES
  )
    return { ok: false, failure: "too_large", tooLargeCause: "request" };
  const result = decodeContextViewRestoreChildResult(raw);
  if (result.ok && process.memoryUsage().rss > CONTEXT_VIEW_RESTORE_RSS_MAX_BYTES)
    return { ok: false, failure: "too_large", tooLargeCause: "restore_limit" };
  if (!result.ok) {
    const detail = firstStderrLine(await stderr);
    return detail === undefined ? result : { ...result, detail };
  }
  return result;
}

export async function runContextViewRestoreInChild(
  request: RestoreRequest,
  options: { timeoutMs?: number; command?: string[] } = {},
): Promise<ContextViewRestoreResult> {
  if (request.buffer.byteLength > CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES)
    return { ok: false, failure: "too_large", tooLargeCause: "session_file" };
  const child = spawnRestoreChild(options);
  const timeoutMs = options.timeoutMs ?? CONTEXT_VIEW_RESTORE_TIMEOUT_MS;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  try {
    child.stdin.write(encodeStreamHeader(request));
    if (request.buffer.byteLength > 0) child.stdin.write(request.buffer);
    await child.stdin.end();
    return await finishRestoreChild(child, stderr);
  } catch {
    const detail = firstStderrLine(await stderr);
    return detail === undefined
      ? { ok: false, failure: "read_failed" }
      : { ok: false, failure: "read_failed", detail };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

export async function runContextViewRestoreFileInChild(
  request: RestoreFileRequest,
  options: { timeoutMs?: number; command?: string[] } = {},
): Promise<{ result: ContextViewRestoreResult; sourceBytes: number }> {
  const maxSourceBytes = Math.min(
    request.maxSourceBytes ?? CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES,
    CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES,
  );
  let child: ReturnType<typeof spawnRestoreChild> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stderr: Promise<string> | undefined;
  let sourceBytes = 0;
  try {
    child = spawnRestoreChild(options);
    const timeoutMs = options.timeoutMs ?? CONTEXT_VIEW_RESTORE_TIMEOUT_MS;
    const spawned = child;
    timer = setTimeout(() => spawned.kill(), timeoutMs);
    stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    child.stdin.write(encodeStreamHeader(request));
    const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await request.handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      sourceBytes += bytesRead;
      if (sourceBytes > maxSourceBytes) {
        child.kill();
        return {
          result: { ok: false, failure: "too_large", tooLargeCause: "session_file" },
          sourceBytes,
        };
      }
      child.stdin.write(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
      await child.stdin.flush();
    }
    await child.stdin.end();
    const result = await finishRestoreChild(child, stderr);
    return { result, sourceBytes };
  } catch {
    const detail = stderr ? firstStderrLine(await stderr) : undefined;
    return {
      result:
        detail === undefined
          ? { ok: false, failure: "read_failed" }
          : { ok: false, failure: "read_failed", detail },
      sourceBytes,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    child?.kill();
    await request.handle.close().catch(() => {});
  }
}

export function firstStderrLine(stderr: string, maxChars = 300): string | undefined {
  const line = stderr.split("\n").find((each) => each.trim() !== "");
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}
