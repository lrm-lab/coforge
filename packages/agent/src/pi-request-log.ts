import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Small serialized writer for the Pi/Builtin captured request log. */
export const PI_REQUEST_LOG_MAX_BYTES = 128 * 1024 * 1024;
export function piRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function piContextRequestDigest(
  shapeHash: string,
  paramsJson: string,
  messageHashes: readonly string[],
): string {
  return createHash("sha256")
    .update(`${shapeHash}\n${paramsJson}\n${messageHashes.join("\n")}`)
    .digest("hex");
}

export class PiRequestLogWriter {
  readonly path: string;
  readonly #trustedRoot?: string;
  #tail = Promise.resolve();
  #lastHash: string | undefined;
  #initialized = false;
  #indexedLast: { id: string; hashes: string[] } | undefined;

  constructor(path: string, trustedRoot?: string) {
    this.path = path;
    this.#trustedRoot = trustedRoot;
  }

  append(record: Record<string, unknown>): Promise<void> {
    this.#tail = this.#tail
      .then(async () => {
        await ensurePrivateDirectory(dirname(this.path), this.#trustedRoot);
        const existing = await lstat(this.path).catch(() => undefined);
        if (existing && (!existing.isFile() || existing.nlink > 1 || existing.isSymbolicLink()))
          return;
        if (!this.#initialized) {
          this.#initialized = true;
          const existing = await readFile(this.path, "utf8").catch(() => "");
          const indexedRequests = new Map<string, Record<string, unknown>>();
          for (const line of existing.trimEnd().split("\n")) {
            try {
              const value = JSON.parse(line) as Record<string, unknown>;
              if (value.type === "request" && typeof value.id === "string" && value.shapeHash)
                indexedRequests.set(value.id, value);
              if (typeof value.hash === "string") this.#lastHash = value.hash;
            } catch {
              // Ignore truncated or malformed tails while preserving readable history.
            }
          }
          const latest = [...indexedRequests.values()].at(-1);
          if (latest && typeof latest.id === "string") {
            const chain: Record<string, unknown>[] = [];
            const seen = new Set<string>();
            let current: Record<string, unknown> | undefined = latest;
            while (current && typeof current.id === "string" && !seen.has(current.id)) {
              seen.add(current.id);
              chain.push(current);
              current =
                typeof current.base === "string" ? indexedRequests.get(current.base) : undefined;
            }
            const hashes: string[] = [];
            let valid =
              current === undefined &&
              (typeof chain.at(-1)?.base !== "string" || chain.at(-1)?.base === null);
            for (const step of chain.reverse()) {
              const keep = typeof step.keep === "number" ? step.keep : 0;
              const tail = Array.isArray(step.tail)
                ? step.tail.filter((hash): hash is string => typeof hash === "string")
                : [];
              if (keep > hashes.length) {
                valid = false;
                break;
              }
              hashes.length = keep;
              hashes.push(...tail);
            }
            if (valid) this.#indexedLast = { id: latest.id, hashes };
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
        const indexed =
          record.type === "request" && isRecord(record.body)
            ? indexedRequestRecords(record.body, record, this.#indexedLast)
            : [];
        const gap =
          record.type === "request" && indexed.length === 0
            ? {
                type: "gap",
                reason: isRecord(record.body) ? "unknown_body" : "not_an_object",
                at: new Date().toISOString(),
              }
            : undefined;
        const line = `${[...indexed, { ...chained, hash }]
          .map((value) => {
            const publicValue = { ...value };
            delete publicValue._fullHashes;
            return JSON.stringify(publicValue);
          })
          .join("\n")}\n`;
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
          if (!info.isFile() || info.nlink > 1) return;
          const output = `${gap ? `${JSON.stringify(gap)}\n` : ""}${line}`;
          if (info.size + Buffer.byteLength(output) > PI_REQUEST_LOG_MAX_BYTES) {
            const overCap = `${JSON.stringify({
              type: "gap",
              reason: "over_cap",
              at: new Date().toISOString(),
            })}\n`;
            if (info.size + Buffer.byteLength(overCap) <= PI_REQUEST_LOG_MAX_BYTES)
              await handle.write(overCap, undefined, "utf8");
            return;
          }
          await handle.write(output, undefined, "utf8");
          this.#lastHash = hash;
          const indexedRequest = indexed.find((value) => value.type === "request");
          if (
            indexedRequest &&
            typeof indexedRequest.id === "string" &&
            Array.isArray(indexedRequest._fullHashes)
          ) {
            this.#indexedLast = {
              id: indexedRequest.id,
              hashes: indexedRequest._fullHashes as string[],
            };
          }
        } finally {
          await handle.close();
        }
      })
      .catch(() => undefined);
    return this.#tail;
  }
}

async function ensurePrivateDirectory(path: string, trustedRoot?: string): Promise<void> {
  const absolute = resolve(path);
  if (trustedRoot) {
    const root = resolve(trustedRoot);
    const child = relative(root, absolute);
    if (child.startsWith("..") || child.includes("\0"))
      throw new Error("Pi request log directory is outside its root");
    let current = root;
    const rootInfo = await lstat(current).catch(() => undefined);
    if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new Error("Pi request log directory is unsafe");
    for (const segment of child.split(sep).filter(Boolean)) {
      current = join(current, segment);
      const info = await lstat(current).catch(() => undefined);
      if (!info) {
        await mkdir(current, { mode: 0o700 });
        const created = await lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory())
          throw new Error("Pi request log directory is unsafe");
      } else if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Pi request log directory is unsafe");
      }
    }
    return;
  }
  const root = parse(absolute).root;
  const missing: string[] = [];
  let current = absolute;
  while (current !== root) {
    const info = await lstat(current).catch(() => undefined);
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Pi request log directory is unsafe");
      break;
    }
    missing.push(current.slice(current.lastIndexOf(sep) + 1));
    current = current.slice(0, current.lastIndexOf(sep)) || root;
  }
  for (const segment of missing.reverse()) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info) {
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory())
        throw new Error("Pi request log directory is unsafe");
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Pi request log directory is unsafe");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexedRequestRecords(
  body: Record<string, unknown>,
  record: Record<string, unknown>,
  previous: { id: string; hashes: string[] } | undefined,
): Array<Record<string, unknown>> {
  const messagesKey = ["messages", "input", "contents"].find((key) => Array.isArray(body[key]));
  if (!messagesKey) return [];
  const messages = body[messagesKey] as unknown[];
  const params: Record<string, unknown> = {};
  const shape: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === messagesKey) continue;
    if (isPiParam(value)) params[key] = value;
    else shape[key] = value;
  }
  if (isRecord(shape.config)) {
    const configShape: Record<string, unknown> = {};
    const configParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape.config)) {
      if (isPiParam(value)) configParams[key] = value;
      else configShape[key] = value;
    }
    params.config = configParams;
    shape.config = configShape;
  }
  const shapeHash = piRequestDigest(shape);
  const blobs = messages.map((message) => ({
    hash: piRequestDigest(message),
    message,
  }));
  const hashes = blobs.map((blob) => blob.hash);
  const paramsJson = JSON.stringify(params);
  let keep = 0;
  while (previous && keep < previous.hashes.length && keep < hashes.length) {
    if (previous.hashes[keep] !== hashes[keep]) break;
    keep += 1;
  }
  const request: Record<string, unknown> = {
    type: "request",
    id: randomUUID(),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    at: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
    api: typeof body.api === "string" ? body.api : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    params,
    shapeHash,
    base: previous?.id ?? null,
    keep,
    tail: hashes.slice(keep),
    digest: piContextRequestDigest(shapeHash, paramsJson, hashes),
    ...(Array.isArray(record.messageIds) ? { messageIds: record.messageIds } : {}),
    _fullHashes: hashes,
  };
  return [
    { type: "shape", hash: shapeHash, messagesKey, shape },
    ...blobs.map((blob) => ({ type: "blob", ...blob })),
    request,
  ];
}

function isPiParam(value: unknown): value is string | number | boolean {
  return (
    typeof value === "number" ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.length <= 256)
  );
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
