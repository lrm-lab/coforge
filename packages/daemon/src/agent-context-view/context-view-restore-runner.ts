import {
  restoreContextView,
  type RestoreRequest,
  type ContextViewRestoreResult,
} from "./context-view-restore";
import { writeFileSync } from "node:fs";

export const CONTEXT_VIEW_RESTORE_TIMEOUT_MS = 25_000;
export const CONTEXT_VIEW_RESTORE_HEAP_MB = 1_024;
export const CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES = 64 * 1024;
export const CONTEXT_VIEW_RESTORE_RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES = 512 * 1024 * 1024;
export const CONTEXT_VIEW_RESTORE_RSS_MAX_BYTES = 1_024 * 1024 * 1024;
export const CONTEXT_VIEW_RESTORE_INPUT_FRAME_MAX_BYTES =
  Math.ceil((CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES * 4) / 3) + CONTEXT_VIEW_RESTORE_HEADER_MAX_BYTES;

type ChildRequest = Omit<RestoreRequest, "buffer"> & { bufferBase64: string };
type ChildHeader = { version: 1; outcome: "ok" | "failed"; bytes: number };

function childRequest(request: RestoreRequest): ChildRequest {
  if (request.buffer.byteLength > CONTEXT_VIEW_RESTORE_INPUT_MAX_BYTES)
    throw new Error("context view restore input is too large");
  const { buffer, ...rest } = request;
  return { ...rest, bufferBase64: buffer.toString("base64") };
}

function restorePayload(request: ChildRequest): ContextViewRestoreResult {
  return restoreContextView({ ...request, buffer: Buffer.from(request.bufferBase64, "base64") });
}

/** The prefix of an entrypoint Bun holds inside its own binary (measured on a compiled Computer:
 * `process.argv[1]` and `Bun.main` are both `/$bunfs/root/<name>`). */
const EMBEDDED_SCRIPT_PREFIX = "/$bunfs/";

/**
 * How this program asks itself to run a subcommand. A compiled Computer is its own entrypoint, so
 * the subcommand is its first argument; under `bun` the script has to come first, or the runtime
 * looks for a file named after the subcommand.
 *
 * The script path is what tells the two apart, and it says so directly: a path inside the runtime's
 * own binary is no file the child could be asked to run, so it is not passed at all. Reading the
 * executable's name instead would guess — a compiled binary may be named `bun-something`, and bun
 * itself can be renamed or reached through a shim (task #739).
 */
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
      // Best effort; the RSS guard below remains authoritative.
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
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildRequest;
  const result =
    process.memoryUsage().rss > CONTEXT_VIEW_RESTORE_RSS_MAX_BYTES
      ? {
          ok: false as const,
          failure: "too_large" as const,
          tooLargeCause: "restore_limit" as const,
        }
      : restorePayload(request);
  process.stdout.write(encodeContextViewRestoreChildResult(result));
}

export async function runContextViewRestoreInChild(
  request: RestoreRequest,
  options: { timeoutMs?: number; command?: string[] } = {},
): Promise<ContextViewRestoreResult> {
  const command = options.command ?? selfSubcommand("__restore-context-view");
  const child = Bun.spawn({
    cmd: command,
    stdin: "pipe",
    stdout: "pipe",
    // Kept, not dropped: a child that cannot start says why on stderr, and that first line is the
    // only clue a failed read leaves behind (task #739).
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
  const timeoutMs = options.timeoutMs ?? CONTEXT_VIEW_RESTORE_TIMEOUT_MS;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  try {
    let body: string;
    try {
      body = JSON.stringify(childRequest(request));
    } catch {
      return { ok: false, failure: "too_large", tooLargeCause: "session_file" };
    }
    await child.stdin.write(body);
    child.stdin.end();
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

/** The child's own words about why it failed, bounded: one line, no paths beyond what it said. */
export function firstStderrLine(stderr: string, maxChars = 300): string | undefined {
  const line = stderr.split("\n").find((each) => each.trim() !== "");
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}
