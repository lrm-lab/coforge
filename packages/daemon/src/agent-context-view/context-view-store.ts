import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { escapePathIdentity, isSafePathScope } from "#src/persistence/path-scope";

export const AGENT_CONTEXT_VIEW_RETENTION_DAYS = 30;
export const AGENT_CONTEXT_VIEW_OFF_GRACE_MS = 24 * 60 * 60 * 1000;
export const AGENT_CONTEXT_INDEX_MAX_BYTES = 8 * 1024 * 1024;
export const CONTEXT_VIEW_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const CONTEXT_VIEW_APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

export type ContextViewIndexEntry = {
  messageId: string;
  sentAt: string;
  runtime: "claude" | "codex" | "kimi-sdk" | "pi" | "builtin";
  sessionId: string;
  transcript: string;
  offset: number;
};

export type ContextViewLookup =
  | { status: "found"; entry: ContextViewIndexEntry }
  | { status: "expired" }
  | { status: "not_recorded" };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RUNTIMES = new Set(["claude", "codex", "kimi-sdk", "pi", "builtin"]);

function assertEntry(entry: ContextViewIndexEntry): void {
  if (!ID.test(entry.messageId) || !ID.test(entry.sessionId))
    throw new Error("Invalid context view identity");
  if (!RUNTIMES.has(entry.runtime)) throw new Error("Invalid context view runtime");
  if (
    !entry.transcript ||
    entry.transcript.startsWith("/") ||
    entry.transcript.includes("\0") ||
    entry.transcript.split("/").includes("..")
  )
    throw new Error("Invalid context view transcript path");
  if (!Number.isSafeInteger(entry.offset) || entry.offset < 0)
    throw new Error("Invalid context view offset");
  if (Number.isNaN(Date.parse(entry.sentAt))) throw new Error("Invalid context view timestamp");
}

function ownDirectory(path: string, root = path): void {
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (!rootInfo) throw new Error("Context view state directory is missing");
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Context view state directory is unsafe");
  let current = root;
  const relative = path === root ? [] : path.slice(root.length).split("/").filter(Boolean);
  for (const segment of relative) {
    current = join(current, segment);
    const existing = lstatSync(current, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new Error("Context view directory is a symlink");
    if (!existing) mkdirSync(current, { mode: 0o700 });
    if (!lstatSync(current).isDirectory()) throw new Error("Context view directory is not private");
  }
}

function ownRegularFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink > 1) throw new Error("Context view file is not private");
}

export class ContextViewStore {
  readonly #directory: string;
  readonly #indexPath: string;
  readonly #offSincePath: string;
  readonly #expiredPath: string;
  readonly #now: () => number;

  constructor(
    stateDirectory: string,
    serverId: string,
    agentId: string,
    now: () => number = Date.now,
  ) {
    if (!stateDirectory || !isSafePathScope(serverId) || !isSafePathScope(agentId))
      throw new Error("Invalid context view store scope");
    const stateInfo = lstatSync(stateDirectory, { throwIfNoEntry: false });
    if (stateInfo?.isSymbolicLink()) throw new Error("Context view state directory is a symlink");
    const serverDirectory = join(stateDirectory, "agent-context", escapePathIdentity(serverId));
    this.#directory = join(serverDirectory, escapePathIdentity(agentId));
    this.#indexPath = join(this.#directory, "index.jsonl");
    this.#offSincePath = join(this.#directory, "off-since");
    this.#expiredPath = join(this.#directory, "expired.jsonl");
    this.#now = now;
    ownDirectory(join(stateDirectory, "agent-context"), stateDirectory);
    ownDirectory(serverDirectory, stateDirectory);
    ownDirectory(this.#directory, stateDirectory);
  }

  static exists(stateDirectory: string, serverId: string, agentId: string): boolean {
    if (!stateDirectory || !isSafePathScope(serverId) || !isSafePathScope(agentId)) return false;
    const directory = join(
      stateDirectory,
      "agent-context",
      escapePathIdentity(serverId),
      escapePathIdentity(agentId),
    );
    try {
      const info = lstatSync(directory);
      return info.isDirectory() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  get indexPath(): string {
    return this.#indexPath;
  }

  record(entry: ContextViewIndexEntry): void {
    assertEntry(entry);
    const line = `${JSON.stringify(entry)}\n`;
    if (existsSync(this.#indexPath)) {
      ownRegularFile(this.#indexPath);
      if (lstatSync(this.#indexPath).size + Buffer.byteLength(line) > AGENT_CONTEXT_INDEX_MAX_BYTES)
        this.compact();
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.#indexPath, CONTEXT_VIEW_APPEND_FLAGS, 0o600);
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink > 1 ||
        info.size + Buffer.byteLength(line) > AGENT_CONTEXT_INDEX_MAX_BYTES
      )
        throw new Error("Context view index is full or unsafe");
      writeFileSync(fd, line, "utf8");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  find(messageId: string): ContextViewIndexEntry | undefined {
    const lookup = this.lookup(messageId);
    return lookup.status === "found" ? lookup.entry : undefined;
  }

  lookup(messageId: string): ContextViewLookup {
    if (!ID.test(messageId)) return { status: "not_recorded" };
    if (existsSync(this.#indexPath)) {
      ownRegularFile(this.#indexPath);
      const fd = openSync(this.#indexPath, CONTEXT_VIEW_READ_FLAGS);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink > 1 || info.size > AGENT_CONTEXT_INDEX_MAX_BYTES)
          return { status: "not_recorded" };
      } finally {
        closeSync(fd);
      }
      const entry = this.#readFileSafely(this.#indexPath)
        .split("\n")
        .flatMap((line) => {
          if (!line) return [];
          try {
            const value = JSON.parse(line) as ContextViewIndexEntry;
            assertEntry(value);
            return value.messageId === messageId ? [value] : [];
          } catch {
            return [];
          }
        })[0];
      if (entry) return { status: "found", entry };
    }
    if (this.#expiredIds().has(messageId)) return { status: "expired" };
    return { status: "not_recorded" };
  }

  oldestSentAt(): string | undefined {
    if (!existsSync(this.#indexPath)) return undefined;
    try {
      const entries = this.#readFileSafely(this.#indexPath)
        .split("\n")
        .flatMap((line) => {
          if (!line) return [];
          try {
            const value = JSON.parse(line) as ContextViewIndexEntry;
            assertEntry(value);
            return [value.sentAt];
          } catch {
            return [];
          }
        });
      return entries.sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    } catch {
      return undefined;
    }
  }

  isOff(): boolean {
    if (!existsSync(this.#offSincePath)) return false;
    try {
      return !Number.isNaN(Date.parse(this.#readFileSafely(this.#offSincePath)));
    } catch {
      return true;
    }
  }

  compact(retentionDays = AGENT_CONTEXT_VIEW_RETENTION_DAYS): number {
    if (!existsSync(this.#indexPath)) return 0;
    ownRegularFile(this.#indexPath);
    const cutoff = this.#now() - retentionDays * 24 * 60 * 60 * 1000;
    const allEntries = this.#readFileSafely(this.#indexPath)
      .split("\n")
      .flatMap((line) => {
        if (!line) return [];
        try {
          const value = JSON.parse(line) as ContextViewIndexEntry;
          assertEntry(value);
          return [value];
        } catch {
          return [];
        }
      })
    const sortedEntries = allEntries.sort(
      (left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt),
    );
    const retained = sortedEntries.filter((entry) => Date.parse(entry.sentAt) >= cutoff);
    this.#markExpired(
      sortedEntries.filter((entry) => !retained.includes(entry)).map((entry) => entry.messageId),
    );
    const entries = retained;
    const encoded = () =>
      entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "");
    const evicted: string[] = [];
    while (Buffer.byteLength(encoded()) > AGENT_CONTEXT_INDEX_MAX_BYTES) {
      const removed = entries.shift();
      if (removed) evicted.push(removed.messageId);
    }
    this.#markExpired(evicted);
    const temp = `${this.#indexPath}.tmp-${process.pid}`;
    const tempFd = openSync(temp, CONTEXT_VIEW_APPEND_FLAGS | (constants.O_EXCL ?? 0), 0o600);
    try {
      writeFileSync(tempFd, encoded(), "utf8");
    } finally {
      closeSync(tempFd);
    }
    renameSync(temp, this.#indexPath);
    return entries.length;
  }

  markOff(now = this.#now()): void {
    if (existsSync(this.#offSincePath)) {
      const current = Date.parse(this.#readFileSafely(this.#offSincePath));
      if (!Number.isNaN(current)) return;
      unlinkSync(this.#offSincePath);
    }
    const fd = openSync(
      this.#offSincePath,
      CONTEXT_VIEW_APPEND_FLAGS | (constants.O_EXCL ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, new Date(now).toISOString(), "utf8");
    } finally {
      closeSync(fd);
    }
  }

  clearOff(): void {
    if (existsSync(this.#offSincePath)) unlinkSync(this.#offSincePath);
  }

  sweepOff(now = this.#now()): boolean {
    if (!existsSync(this.#offSincePath)) return false;
    const offSince = Date.parse(this.#readFileSafely(this.#offSincePath));
    if (Number.isNaN(offSince) || now - offSince < AGENT_CONTEXT_VIEW_OFF_GRACE_MS) return false;
    const ids = existsSync(this.#indexPath)
      ? this.#readFileSafely(this.#indexPath)
          .split("\n")
          .flatMap((line) => {
            if (!line) return [];
            try {
              const value = JSON.parse(line) as ContextViewIndexEntry;
              assertEntry(value);
              return [value.messageId];
            } catch {
              return [];
            }
          })
      : [];
    this.#markExpired(ids);
    for (const name of readdirSync(this.#directory)) {
      if (name !== "off-since" && name !== "expired.jsonl") {
        const path = join(this.#directory, name);
        if (existsSync(path)) unlinkSync(path);
      }
    }
    if (existsSync(this.#offSincePath)) unlinkSync(this.#offSincePath);
    return true;
  }

  #readFileSafely(path: string): string {
    ownRegularFile(path);
    const fd = openSync(path, CONTEXT_VIEW_READ_FLAGS);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1) throw new Error("Context view file is not private");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  #expiredIds(): Set<string> {
    if (!existsSync(this.#expiredPath)) return new Set();
    try {
      return new Set(
        this.#readFileSafely(this.#expiredPath)
          .split("\n")
          .flatMap((line) => (ID.test(line) ? [line] : [])),
      );
    } catch {
      return new Set();
    }
  }

  #markExpired(ids: string[]): void {
    if (!ids.length) return;
    const merged = [...new Set([...this.#expiredIds(), ...ids])].slice(-10_000);
    const temp = `${this.#expiredPath}.tmp-${process.pid}`;
    const fd = openSync(temp, CONTEXT_VIEW_APPEND_FLAGS | (constants.O_EXCL ?? 0), 0o600);
    try {
      writeFileSync(fd, `${merged.join("\n")}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.#expiredPath);
  }
}
