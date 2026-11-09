import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

/** Small serialized writer for the Pi/Builtin captured request log. */
export const PI_REQUEST_LOG_MAX_BYTES = 128 * 1024 * 1024;
export function piRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export class PiRequestLogWriter {
  readonly path: string;
  #tail = Promise.resolve();
  #lastHash: string | undefined;
  #initialized = false;

  constructor(path: string) {
    this.path = path;
  }

  append(record: Record<string, unknown>): Promise<void> {
    this.#tail = this.#tail
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const existing = await lstat(this.path).catch(() => undefined);
        if (existing && (!existing.isFile() || existing.nlink > 1 || existing.isSymbolicLink()))
          return;
        if (!this.#initialized) {
          this.#initialized = true;
          const existing = await readFile(this.path, "utf8").catch(() => "");
          for (const line of existing.trimEnd().split("\n").reverse()) {
            try {
              const value = JSON.parse(line) as Record<string, unknown>;
              if (typeof value.hash === "string") {
                this.#lastHash = value.hash;
                break;
              }
            } catch {
              // Ignore a truncated tail; the append remains observational.
            }
          }
        }
        const chained = {
          ...record,
          ...(this.#lastHash ? { prevHash: this.#lastHash } : {}),
          ...(record.type === "request" && record.body !== undefined
            ? { digest: piRequestDigest(record.body) }
            : {}),
        };
        const hash = piRequestDigest(chained);
        const line = `${JSON.stringify({ ...chained, hash })}\n`;
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
          this.#lastHash = hash;
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
