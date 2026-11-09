import { lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

/** Small serialized writer for the Pi/Builtin captured request log. */
export const PI_REQUEST_LOG_MAX_BYTES = 128 * 1024 * 1024;
export class PiRequestLogWriter {
  readonly path: string;
  #tail = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  append(record: Record<string, unknown>): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      // Logging is observational and must never prevent a provider request.
      return Promise.resolve();
    }
    this.#tail = this.#tail
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const existing = await lstat(this.path).catch(() => undefined);
        if (existing && (!existing.isFile() || existing.nlink > 1 || existing.isSymbolicLink()))
          return;
        const handle = await open(
          this.path,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
          0o600,
        );
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.nlink > 1 ||
            info.size + Buffer.byteLength(line) > PI_REQUEST_LOG_MAX_BYTES
          )
            return;
          await handle.write(line, undefined, "utf8");
        } finally {
          await handle.close();
        }
      })
      .catch(() => undefined);
    return this.#tail;
  }
}

/** Returns a JSON-safe Pi request body while preserving provider message shape. */
export function piRequestBody(context: unknown, model: unknown): Record<string, unknown> {
  const value = sanitizePiValue(context);
  const candidate = model && typeof model === "object" ? (model as Record<string, unknown>) : {};
  if (typeof candidate.id === "string") value.model = candidate.id;
  if (typeof candidate.api === "string") value.api = candidate.api;
  return value;
}

function sanitizePiValue(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (seen.has(record)) return { kind: "cycle" };
  if (record.type === "image" || record.type === "audio" || record.type === "media") {
    return {
      type: "media_removed",
      mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
    };
  }
  const output: Record<string, unknown> = {};
  seen.set(record, output);
  for (const [key, child] of Object.entries(record)) {
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        output[key] = child.map((item) =>
          item && typeof item === "object" ? sanitizePiNested(item, seen) : item,
        );
      } else output[key] = sanitizePiNested(child, seen);
    } else output[key] = child;
  }
  return output;
}

function sanitizePiNested(value: object, seen: WeakMap<object, unknown>): unknown {
  if (seen.has(value)) return { kind: "cycle" };
  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "audio" || record.type === "media")
    return { type: "media_removed" };
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, child] of Object.entries(record)) {
    output[key] =
      child && typeof child === "object"
        ? Array.isArray(child)
          ? child.map((item) =>
              item && typeof item === "object" ? sanitizePiNested(item, seen) : item,
            )
          : sanitizePiNested(child, seen)
        : child;
  }
  return output;
}

export function piContextHasMedia(value: unknown): boolean {
  return piContextHasMediaSeen(value, new WeakSet<object>());
}

function piContextHasMediaSeen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => piContextHasMediaSeen(item, seen));
  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "audio" || record.type === "media") return true;
  return Object.values(record).some((item) => piContextHasMediaSeen(item, seen));
}
