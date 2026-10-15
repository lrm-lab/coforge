import { constants } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { pack, type Pack } from "tar-stream";
import { isSecretName, isWorkspaceSymlinkTarget } from "./selection-rules";
import type {
  AgentMigrationWorkspaceEntry,
  AgentMigrationWorkspaceSelection,
} from "./workspace-selection";

/**
 * Writes the selected workspace as one gzip-compressed tar stream, cut into fixed-size chunks as
 * it is produced, so a migration never holds the whole bundle in memory or on disk. `Bun.Archive`
 * builds an archive in memory, which a bundle of up to 10 GiB cannot afford, so the tar is written
 * with `tar-stream`, as in the reference Computer. Every entry sits under `workspace/` with its
 * permission bits and modification time.
 *
 * As in the reference, each entry is re-read when it is packed: a file at its size then, a symlink
 * with its target then, normalized. A file that changes while it is read is cut or zero-padded to
 * keep the tar well formed and is reported as drift; one gone, or no longer the same kind, is
 * skipped. Any other read failure fails the bundle rather than leaving the file behind unnoticed.
 */

export const AGENT_MIGRATION_CHUNK_BYTES = 8 * 1024 * 1024;
export const AGENT_MIGRATION_MIN_CHUNK_BYTES = 1024 * 1024;
export const AGENT_MIGRATION_MAX_CHUNKS = 2048;
export const AGENT_MIGRATION_MAX_BUNDLE_BYTES = 10 * 1024 * 1024 * 1024;
export const AGENT_MIGRATION_MAX_ENTRIES = 2_000_000;
export const AGENT_MIGRATION_BUNDLE_CONTENT_TYPE =
  "application/vnd.coforge.agent-migration-bundle+tar+gzip";

/** The prefix every bundle entry sits under. */
export const AGENT_MIGRATION_BUNDLE_ROOT = "workspace";

/** How many chunks the consumer (the upload) may hold at once. */
const CHUNKS_IN_FLIGHT = 3;
/** A file up to this size is read whole and handed to the tar in one piece. */
const BUFFERED_FILE_BYTES = 1024 * 1024;
const READ_BYTES = 256 * 1024;
/** How many entries are opened and read ahead of the one being written. */
const READ_AHEAD = 16;
const ZEROES = new Uint8Array(READ_BYTES);
/** Errors that mean the entry is gone or is no longer the regular file it was selected as. */
const GONE_OR_CHANGED_KIND = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EMLINK"]);

export type AgentMigrationBundleChunk = {
  index: number;
  offsetBytes: number;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
};

/** What the target needs to fetch, verify and extract the bundle. */
export type AgentMigrationBundleManifest = {
  format: "tar+gzip";
  contentType: typeof AGENT_MIGRATION_BUNDLE_CONTENT_TYPE;
  entryCount: number;
  /** Uncompressed bytes of the files carried; the target checks it after extraction. */
  expandedBytes: number;
  maxEntryBytes: number;
  memoryMdPresent: boolean;
  notesPresent: boolean;
  /** Compressed bundle size and digest, over all chunks in order. */
  sizeBytes: number;
  sha256: string;
  chunkSizeBytes: number;
  chunks: Omit<AgentMigrationBundleChunk, "bytes">[];
};

/** How the workspace changed while it was packed; reported, never sent as content. */
export type AgentMigrationBundleDrift = {
  /** Files that changed size while being read; cut or zero-padded to their packed size. */
  resized: string[];
  /** Selected entries gone, or no longer the same kind, by the time they were packed. */
  skipped: string[];
};

export class AgentMigrationBundleLimitError extends Error {
  constructor(
    readonly limit: "bundle_bytes" | "entry_count",
    readonly maximum: number,
    /** For `entry_count`: where the entries are, secret-looking names counted as `other/`. */
    readonly largestTopLevelPaths: { path: string; entryCount: number }[] = [],
  ) {
    super(
      limit === "bundle_bytes"
        ? `Agent migration bundle exceeds ${maximum} bytes`
        : `Agent migration selection exceeds ${maximum} entries`,
    );
    this.name = "AgentMigrationBundleLimitError";
  }
}

function largestTopLevelPaths(entries: AgentMigrationWorkspaceEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const top = entry.path.split("/")[0]!;
    const label = isSecretName(top) ? "other/" : top;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([path, entryCount]) => ({ path, entryCount }))
    .sort((left, right) => right.entryCount - left.entryCount || (left.path < right.path ? -1 : 1))
    .slice(0, 3);
}

/**
 * A sink that cuts compressed bytes into chunks of exactly `chunkBytes`, the last shorter, and
 * hands up to `CHUNKS_IN_FLIGHT` of them to the consumer at once.
 */
function chunkSink(input: {
  chunkBytes: number;
  maxBytes: number;
  onChunk: (chunk: AgentMigrationBundleChunk) => Promise<void>;
}) {
  const bundleHash = new Bun.CryptoHasher("sha256");
  const chunks: AgentMigrationBundleManifest["chunks"] = [];
  const inFlight = new Set<Promise<void>>();
  let refused: unknown;
  let buffer = new Uint8Array(input.chunkBytes);
  let fill = 0;
  let total = 0;
  let offset = 0;

  const handOver = async (chunk: AgentMigrationBundleChunk) => {
    while (inFlight.size >= CHUNKS_IN_FLIGHT) await Promise.race(inFlight);
    if (refused) throw refused;
    const task = input.onChunk(chunk).then(
      () => {
        inFlight.delete(task);
      },
      (error: unknown) => {
        inFlight.delete(task);
        refused ??= error;
      },
    );
    inFlight.add(task);
  };

  const emit = async () => {
    const bytes = buffer.subarray(0, fill);
    const chunk = {
      index: chunks.length,
      offsetBytes: offset,
      sizeBytes: fill,
      sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") as string,
    };
    chunks.push(chunk);
    offset += fill;
    // The consumer keeps these bytes while it works, so the next chunk gets a fresh buffer.
    buffer = new Uint8Array(input.chunkBytes);
    fill = 0;
    await handOver({ ...chunk, bytes });
  };

  const sink = new WritableStream<Uint8Array>({
    async write(data) {
      if (refused) throw refused;
      total += data.byteLength;
      if (total > input.maxBytes)
        throw new AgentMigrationBundleLimitError("bundle_bytes", input.maxBytes);
      bundleHash.update(data);
      for (let start = 0; start < data.byteLength;) {
        const take = Math.min(input.chunkBytes - fill, data.byteLength - start);
        buffer.set(data.subarray(start, start + take), fill);
        fill += take;
        start += take;
        if (fill === input.chunkBytes) await emit();
      }
    },
    async close() {
      if (fill > 0) await emit();
      await Promise.all(inFlight);
      if (refused) throw refused;
    },
  });
  const result = () => ({
    sizeBytes: total,
    sha256: bundleHash.digest("hex"),
    chunkSizeBytes: input.chunkBytes,
    chunks,
  });
  return { sink, result };
}

type EntrySink = ReturnType<Pack["entry"]>;
type Header = Parameters<Pack["entry"]>[0];

/** An entry re-read for packing; a small file's bytes are read ahead of being written. */
type PreparedEntry =
  | { kind: "symlink"; header: Header }
  | { kind: "buffered"; header: Header; bytes: Uint8Array; resized: boolean }
  | { kind: "streamed"; header: Header; handle: FileHandle; sizeBytes: number };

/**
 * streamx's `write` takes no callback: it returns false under backpressure, then emits `drain`.
 * A sink destroyed meanwhile emits `close` instead, which ends the wait.
 */
async function writeTo(sink: EntrySink, data: Uint8Array) {
  if (sink.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      sink.off("drain", onDrain);
      sink.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => settle();
    const onClose = () => settle(new Error("tar entry closed before it was written"));
    sink.on("drain", onDrain);
    sink.on("close", onClose);
  });
}

/** Reads exactly `sizeBytes` from the start of the file, zero-padded if it shrank meanwhile. */
async function readExactly(handle: FileHandle, sizeBytes: number) {
  const bytes = new Uint8Array(sizeBytes);
  let read = 0;
  while (read < sizeBytes) {
    const { bytesRead } = await handle.read(bytes, read, sizeBytes - read, read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  // `bytes` starts zeroed, so a shrunk file is already padded.
  return { bytes, resized: read !== sizeBytes || (await handle.stat()).size !== sizeBytes };
}

/** Streams exactly `sizeBytes` of a large file into its tar entry; true if it changed meanwhile. */
async function streamExactly(handle: FileHandle, sizeBytes: number, sink: EntrySink) {
  let written = 0;
  while (written < sizeBytes) {
    // A fresh buffer per read: the tar keeps a reference to what it is given.
    const buffer = new Uint8Array(Math.min(READ_BYTES, sizeBytes - written));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, written);
    if (bytesRead === 0) break;
    await writeTo(sink, buffer.subarray(0, bytesRead));
    written += bytesRead;
  }
  const changed = (await handle.stat()).size !== sizeBytes;
  for (let missing = sizeBytes - written; missing > 0; missing -= READ_BYTES)
    await writeTo(sink, ZEROES.subarray(0, Math.min(missing, READ_BYTES)));
  return changed || written !== sizeBytes;
}

/** Adds one entry and resolves once tar-stream has written it. */
function addEntry(
  tar: Pack,
  header: Header,
  body?: Uint8Array | ((sink: EntrySink) => Promise<void>),
) {
  return new Promise<void>((resolve, reject) => {
    const done = (error?: Error | null) => (error ? reject(error) : resolve());
    if (typeof body !== "function") {
      tar.entry(header, body ?? new Uint8Array(0), done);
      return;
    }
    const sink = tar.entry(header, done);
    sink.on("error", reject);
    body(sink).then(
      // streamx's `end` writes nothing for `undefined`; its typings just require the argument.
      () => sink.end(undefined),
      (error: unknown) => {
        sink.destroy(error as Error);
        reject(error);
      },
    );
  });
}

function isGoneOrChangedKind(error: unknown) {
  return GONE_OR_CHANGED_KIND.has((error as { code?: string }).code ?? "");
}

/**
 * Re-reads a selected entry for packing, or returns null when it is gone or no longer the same
 * kind. A file is opened with `O_NOFOLLOW` and stat-ed through that handle (hence
 * `node:fs/promises` rather than `Bun.file`), so the bytes read belong to the file whose size,
 * mode and time are recorded, and a file swapped for a symlink is skipped rather than followed.
 */
async function prepare(
  root: string,
  entry: AgentMigrationWorkspaceEntry,
): Promise<PreparedEntry | null> {
  const path = join(root, entry.path);
  const name = `${AGENT_MIGRATION_BUNDLE_ROOT}/${entry.path}`;
  if (entry.kind === "symlink") {
    let stats, linkTarget;
    try {
      stats = await lstat(path);
      if (!stats.isSymbolicLink()) return null;
      linkTarget = posix.normalize(await readlink(path));
    } catch (error) {
      if (isGoneOrChangedKind(error)) return null;
      throw error;
    }
    // Retargeted since selection to somewhere it may not go: no longer the link that was selected.
    if (!isWorkspaceSymlinkTarget(root, dirname(path), linkTarget)) return null;
    return {
      kind: "symlink",
      header: {
        name,
        type: "symlink",
        size: 0,
        linkname: linkTarget,
        mode: stats.mode & 0o777,
        mtime: stats.mtime,
      },
    };
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isGoneOrChangedKind(error)) return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return null;
    }
    const header: Header = {
      name,
      type: "file",
      size: stats.size,
      mode: stats.mode & 0o777,
      mtime: stats.mtime,
    };
    if (stats.size > BUFFERED_FILE_BYTES)
      return { kind: "streamed", header, handle, sizeBytes: stats.size };
    const { bytes, resized } = await readExactly(handle, stats.size);
    await handle.close();
    return { kind: "buffered", header, bytes, resized };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function validate(chunkBytes: number, maxBytes: number) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < AGENT_MIGRATION_MIN_CHUNK_BYTES)
    throw new Error("Agent migration chunks must be a whole number of bytes, at least 1 MiB");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Agent migration bundle limit must be a positive whole number of bytes");
  if (Math.ceil(maxBytes / chunkBytes) > AGENT_MIGRATION_MAX_CHUNKS)
    throw new Error(
      `Agent migration bundle limit would need more than ${AGENT_MIGRATION_MAX_CHUNKS} chunks`,
    );
}

export async function writeAgentMigrationBundle(input: {
  workspaceDirectory: string;
  selection: AgentMigrationWorkspaceSelection;
  /** Called with each chunk in order; up to three may be outstanding at once. */
  onChunk: (chunk: AgentMigrationBundleChunk) => Promise<void>;
  chunkBytes?: number;
  maxBytes?: number;
  maxEntries?: number;
}): Promise<{ manifest: AgentMigrationBundleManifest; drift: AgentMigrationBundleDrift }> {
  const chunkBytes = input.chunkBytes ?? AGENT_MIGRATION_CHUNK_BYTES;
  const maxBytes = input.maxBytes ?? AGENT_MIGRATION_MAX_BUNDLE_BYTES;
  const maxEntries = input.maxEntries ?? AGENT_MIGRATION_MAX_ENTRIES;
  validate(chunkBytes, maxBytes);
  const entries = input.selection.entries;
  if (entries.length > maxEntries)
    throw new AgentMigrationBundleLimitError(
      "entry_count",
      maxEntries,
      largestTopLevelPaths(entries),
    );

  const { sink, result } = chunkSink({ chunkBytes, maxBytes, onChunk: input.onChunk });
  const tar = pack();
  // A failure surfaces through the pipe or the producer; the stream's own `error` event repeats it.
  tar.on("error", () => {});
  const counts = {
    entryCount: 0,
    expandedBytes: 0,
    maxEntryBytes: 0,
    memoryMdPresent: false,
    notesPresent: false,
  };
  const drift: AgentMigrationBundleDrift = { resized: [], skipped: [] };

  const produce = async () => {
    const ahead: Promise<PreparedEntry | null>[] = [];
    let next = 0;
    try {
      for (const entry of entries) {
        while (next < entries.length && ahead.length < READ_AHEAD) {
          const prepared = prepare(input.workspaceDirectory, entries[next++]!);
          // A read-ahead failure is reported when its turn comes, not as an unhandled rejection.
          prepared.catch(() => {});
          ahead.push(prepared);
        }
        const prepared = await ahead.shift()!;
        if (!prepared) {
          drift.skipped.push(entry.path);
          continue;
        }
        let resized = false;
        if (prepared.kind === "symlink") await addEntry(tar, prepared.header);
        else if (prepared.kind === "buffered") {
          await addEntry(tar, prepared.header, prepared.bytes);
          resized = prepared.resized;
        } else {
          try {
            await addEntry(tar, prepared.header, async (entrySink) => {
              resized = await streamExactly(prepared.handle, prepared.sizeBytes, entrySink);
            });
          } finally {
            await prepared.handle.close();
          }
        }
        if (resized) drift.resized.push(entry.path);
        counts.entryCount += 1;
        if (prepared.kind !== "symlink") {
          const sizeBytes = prepared.header.size ?? 0;
          counts.expandedBytes += sizeBytes;
          counts.maxEntryBytes = Math.max(counts.maxEntryBytes, sizeBytes);
        }
        if (entry.path === "MEMORY.md") counts.memoryMdPresent = true;
        if (entry.path.startsWith("notes/")) counts.notesPresent = true;
      }
      tar.finalize();
    } catch (error) {
      tar.destroy(error as Error);
      throw error;
    } finally {
      // Entries read ahead but never written may still hold an open file.
      await Promise.all(
        ahead.map((pending) =>
          pending.then(
            (prepared) => (prepared?.kind === "streamed" ? prepared.handle.close() : undefined),
            () => undefined,
          ),
        ),
      );
    }
  };

  // The tar as a web stream (Bun's typings lack `ReadableStream.from`), so the pipe carries
  // backpressure to it and cancels it when a chunk is refused.
  const tarBytes = (tar as AsyncIterable<Uint8Array<ArrayBuffer>>)[Symbol.asyncIterator]();
  const tarStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const { done, value } = await tarBytes.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      tar.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  });
  const pipe = tarStream
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(sink)
    .catch((error: unknown) => {
      // A refused chunk or the size limit stops the producer too.
      tar.destroy(error as Error);
      throw error;
    });

  // Settle both stages, so no file is left open, before reporting the first failure.
  const [produced, piped] = await Promise.allSettled([produce(), pipe]);
  for (const outcome of [piped, produced]) if (outcome.status === "rejected") throw outcome.reason;
  return {
    manifest: {
      format: "tar+gzip",
      contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
      ...counts,
      ...result(),
    },
    drift,
  };
}
