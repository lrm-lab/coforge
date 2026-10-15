import { afterEach, expect, spyOn, test } from "bun:test";
import * as fileSystem from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pack } from "tar-stream";
import {
  AGENT_MIGRATION_COMMIT_MARKER,
  commitAgentMigrationBundle,
  rollBackAgentMigrationPlacement,
} from "#src/agent-migration/bundle-commit";
import { AgentMigrationCommitError } from "#src/agent-migration/commit-error";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_CHUNK_BYTES,
  writeAgentMigrationBundle,
  type AgentMigrationBundleChunk,
  type AgentMigrationBundleManifest,
} from "#src/agent-migration/bundle-writer";
import { storeAgentMigrationChunk } from "#src/agent-migration/chunk-store";
import { selectAgentMigrationWorkspace } from "#src/agent-migration/workspace-selection";

const MiB = 1024 * 1024;
const tempRoot = realpathSync(tmpdir());
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(prefix: string) {
  const root = await mkdtemp(join(tempRoot, prefix));
  roots.push(root);
  return root;
}

async function sourceWorkspace(files: Record<string, string>) {
  const root = await temp("agent-migration-source-");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await Bun.write(join(root, path), content);
  }
  return root;
}

const migration = { agentId: "agent-1", migrationId: "migration-1", generation: 1 };

type TargetPaths = Awaited<ReturnType<typeof target>>;

/** A target Computer's paths for one Agent: its workspace, the migration's chunks, its backups. */
async function target() {
  const home = await temp("agent-migration-target-");
  return {
    workspaceDirectory: join(home, "workspaces", "ws", "agents", "agent-1"),
    migrationDirectory: join(
      home,
      "migrations",
      migration.migrationId,
      String(migration.generation),
    ),
    backupDirectory: join(home, "migration-workspace-backups", "agent-1"),
  };
}

/** Packs a workspace on the "source" and stores every chunk on the "target", as a download would. */
async function transfer(source: string, paths: TargetPaths) {
  const chunks: AgentMigrationBundleChunk[] = [];
  const { manifest } = await writeAgentMigrationBundle({
    workspaceDirectory: source,
    selection: await selectAgentMigrationWorkspace(source),
    onChunk: async (chunk) => {
      chunks.push(chunk);
    },
  });
  for (const chunk of chunks)
    await storeAgentMigrationChunk(paths.migrationDirectory, chunk, chunk.bytes);
  return manifest;
}

/** Builds a bundle from hand-written tar entries, for archives a CoForge source would never make. */
async function craftedBundle(
  entries: {
    name: string;
    type?: "file" | "symlink" | "directory" | "fifo";
    content?: string;
    linkname?: string;
  }[],
  paths: TargetPaths,
): Promise<AgentMigrationBundleManifest> {
  const tar = pack();
  for (const entry of entries) {
    const body = entry.content ?? "";
    await new Promise<void>((resolve, reject) =>
      tar.entry(
        {
          name: entry.name,
          type: entry.type ?? "file",
          size: entry.type && entry.type !== "file" ? 0 : body.length,
          linkname: entry.linkname,
          mode: 0o644,
        },
        entry.type && entry.type !== "file" ? "" : body,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  tar.finalize();
  const parts: Buffer[] = [];
  for await (const part of tar) parts.push(part as Buffer);
  const bytes = new Uint8Array(Bun.gzipSync(new Uint8Array(Buffer.concat(parts))));
  const sha256 = Bun.CryptoHasher.hash("sha256", bytes, "hex") as string;
  const chunk = { index: 0, offsetBytes: 0, sizeBytes: bytes.byteLength, sha256 };
  await storeAgentMigrationChunk(paths.migrationDirectory, chunk, bytes);
  const files = entries.filter((entry) => !entry.type || entry.type === "file");
  return {
    format: "tar+gzip",
    contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
    entryCount: entries.length,
    expandedBytes: files.reduce((sum, entry) => sum + (entry.content ?? "").length, 0),
    maxEntryBytes: Math.max(0, ...files.map((entry) => (entry.content ?? "").length)),
    memoryMdPresent: false,
    notesPresent: false,
    sizeBytes: bytes.byteLength,
    sha256,
    chunkSizeBytes: AGENT_MIGRATION_CHUNK_BYTES,
    chunks: [chunk],
  };
}

async function commit(
  paths: TargetPaths,
  manifest: AgentMigrationBundleManifest,
  agentRunning = false,
) {
  return commitAgentMigrationBundle({ ...paths, ...migration, manifest, agentRunning });
}

async function errorCode(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AgentMigrationCommitError);
  return (error as AgentMigrationCommitError).code;
}

test("places a transferred workspace whole: content, modes, times, symlinks and its commit marker", async () => {
  const source = await sourceWorkspace({
    "MEMORY.md": "# memory",
    "notes/active-context.md": "next: ship",
    "bin/run.sh": "#!/bin/sh\n",
    "data/large.txt": "x".repeat(2 * MiB),
  });
  await chmod(join(source, "bin/run.sh"), 0o755);
  const fixed = new Date("2026-10-01T08:00:00.000Z");
  await utimes(join(source, "MEMORY.md"), fixed, fixed);
  await symlink("notes/active-context.md", join(source, "context"));
  const paths = await target();

  const manifest = await transfer(source, paths);
  expect(await commit(paths, manifest)).toEqual({ outcome: "committed" });

  const placed = paths.workspaceDirectory;
  expect(await readFile(join(placed, "MEMORY.md"), "utf8")).toBe("# memory");
  expect(await readFile(join(placed, "data/large.txt"), "utf8")).toBe("x".repeat(2 * MiB));
  expect((await stat(join(placed, "bin/run.sh"))).mode & 0o777).toBe(0o755);
  expect((await stat(join(placed, "MEMORY.md"))).mtimeMs).toBe(fixed.getTime());
  expect(await readlink(join(placed, "context"))).toBe("notes/active-context.md");
  const marker = JSON.parse(await readFile(join(placed, AGENT_MIGRATION_COMMIT_MARKER), "utf8"));
  expect(marker).toMatchObject({ ...migration, bundleSha256: manifest.sha256 });
  expect((await stat(join(placed, AGENT_MIGRATION_COMMIT_MARKER))).mode & 0o777).toBe(0o600);
  // Nothing is left half-extracted next to the chunks.
  expect(
    (await readdir(paths.migrationDirectory)).filter((name) => name.startsWith("extracting")),
  ).toEqual([]);
});

test("committing the same bundle again is a no-op that reports it was already committed", async () => {
  const paths = await target();
  const manifest = await transfer(await sourceWorkspace({ "MEMORY.md": "m" }), paths);
  await commit(paths, manifest);
  await writeFile(join(paths.workspaceDirectory, "after.txt"), "the Agent kept working");
  expect(await commit(paths, manifest)).toEqual({ outcome: "already_committed" });
  expect(await readFile(join(paths.workspaceDirectory, "after.txt"), "utf8")).toBe(
    "the Agent kept working",
  );
});

test("moves a workspace already on the target aside, intact, before placing the migrated one", async () => {
  const paths = await target();
  await mkdir(paths.workspaceDirectory, { recursive: true });
  await writeFile(join(paths.workspaceDirectory, "old.txt"), "left from before");
  const manifest = await transfer(await sourceWorkspace({ "MEMORY.md": "new" }), paths);

  const result = await commit(paths, manifest);

  const backup = join(paths.backupDirectory, `preexisting-${migration.migrationId}`);
  expect(result).toEqual({ outcome: "committed", movedAsideTo: backup });
  expect(await readFile(join(backup, "old.txt"), "utf8")).toBe("left from before");
  expect(await readFile(join(paths.workspaceDirectory, "MEMORY.md"), "utf8")).toBe("new");
  expect(await Bun.file(join(paths.workspaceDirectory, "old.txt")).exists()).toBe(false);
});

test("also moves aside a complete copy from a different migration", async () => {
  const paths = await target();
  const first = await transfer(await sourceWorkspace({ "MEMORY.md": "first" }), paths);
  await commit(paths, first);
  await rm(paths.migrationDirectory, { recursive: true });
  const second = await transfer(await sourceWorkspace({ "MEMORY.md": "second" }), paths);

  const result = await commitAgentMigrationBundle({
    ...paths,
    ...migration,
    migrationId: "migration-2",
    manifest: second,
    agentRunning: false,
  });

  expect(result.outcome).toBe("committed");
  expect(await readFile(join(paths.workspaceDirectory, "MEMORY.md"), "utf8")).toBe("second");
  expect(
    await readFile(join(paths.backupDirectory, "preexisting-migration-2", "MEMORY.md"), "utf8"),
  ).toBe("first");
});

test("refuses to move aside a workspace whose Agent is running on the target", async () => {
  const paths = await target();
  await mkdir(paths.workspaceDirectory, { recursive: true });
  const manifest = await transfer(await sourceWorkspace({ "MEMORY.md": "m" }), paths);
  expect(await errorCode(commit(paths, manifest, true))).toBe("workspace_in_use");
});

test("refuses a bundle with a missing or altered chunk, placing nothing", async () => {
  const source = await sourceWorkspace({ "a.txt": "a" });
  const missing = await target();
  const manifest = await transfer(source, missing);
  await rm(join(missing.migrationDirectory, "chunks", "0.chunk"));
  expect(await errorCode(commit(missing, manifest))).toBe("chunks_missing");

  const altered = await target();
  const stored = await transfer(source, altered);
  const chunkPath = join(altered.migrationDirectory, "chunks", "0.chunk");
  const bytes = new Uint8Array(await readFile(chunkPath));
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  await writeFile(chunkPath, bytes);
  expect(await errorCode(commit(altered, stored))).toBe("chunk_digest_mismatch");
  expect(await Bun.file(altered.workspaceDirectory).exists()).toBe(false);
});

test("stores a downloaded chunk only when it matches, and reuses a stored one", async () => {
  const paths = await target();
  const bytes = new TextEncoder().encode("chunk bytes");
  const chunk = {
    index: 0,
    offsetBytes: 0,
    sizeBytes: bytes.byteLength,
    sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") as string,
  };
  expect(await storeAgentMigrationChunk(paths.migrationDirectory, chunk, bytes)).toBe("stored");
  expect(await storeAgentMigrationChunk(paths.migrationDirectory, chunk, bytes)).toBe("reused");
  const wrong = { ...chunk, index: 1 };
  // A stored chunk that no longer matches is reported, never silently overwritten.
  await writeFile(join(paths.migrationDirectory, "chunks", "0.chunk"), "corrupted");
  expect(await errorCode(storeAgentMigrationChunk(paths.migrationDirectory, chunk, bytes))).toBe(
    "chunk_digest_mismatch",
  );
  expect(
    await errorCode(
      storeAgentMigrationChunk(
        paths.migrationDirectory,
        wrong,
        new TextEncoder().encode("other bytes"),
      ),
    ),
  ).toBe("chunk_digest_mismatch");
  expect((await readdir(join(paths.migrationDirectory, "chunks"))).sort()).toEqual(["0.chunk"]);
  expect((await lstat(join(paths.migrationDirectory, "chunks", "0.chunk"))).mode & 0o777).toBe(
    0o600,
  );
});

for (const [name, entries, code] of [
  [
    "a path outside the workspace root",
    [{ name: "workspace/../escape.txt", content: "x" }],
    "unsafe_path",
  ],
  [
    "an entry outside the workspace/ prefix",
    [{ name: "elsewhere/a.txt", content: "x" }],
    "unsafe_path",
  ],
  ["an absolute path", [{ name: "/workspace/a.txt", content: "x" }], "unsafe_path"],
  [
    "the same path twice",
    [
      { name: "workspace/a.txt", content: "1" },
      { name: "workspace/a.txt", content: "2" },
    ],
    "unsafe_path",
  ],
  [
    "the commit marker",
    [{ name: `workspace/${AGENT_MIGRATION_COMMIT_MARKER}`, content: "{}" }],
    "reserved_path",
  ],
  [
    "a symlink leaving the workspace",
    [{ name: "workspace/out", type: "symlink", linkname: "../../etc/passwd" }],
    "unsafe_link",
  ],
  [
    "a symlink that is not normalized",
    [
      { name: "workspace/a.txt", content: "a" },
      { name: "workspace/l", type: "symlink", linkname: "./a.txt" },
    ],
    "unsafe_link",
  ],
  [
    "an entry under a symlinked directory",
    [
      { name: "workspace/dir", type: "symlink", linkname: "notes" },
      { name: "workspace/dir/x.txt", content: "x" },
    ],
    "unsafe_path",
  ],
  ["a special file", [{ name: "workspace/pipe", type: "fifo" }], "unsupported_entry"],
] as const) {
  test(`refuses a bundle with ${name}, placing nothing`, async () => {
    const paths = await target();
    const manifest = await craftedBundle([...entries], paths);
    expect(await errorCode(commit(paths, manifest))).toBe(code);
    expect(await Bun.file(paths.workspaceDirectory).exists()).toBe(false);
  });
}

test("refuses a bundle whose contents do not add up to its manifest", async () => {
  const paths = await target();
  const manifest = await craftedBundle([{ name: "workspace/a.txt", content: "abc" }], paths);
  expect(await errorCode(commit(paths, { ...manifest, entryCount: 2 }))).toBe("manifest_mismatch");
  expect(await errorCode(commit(paths, { ...manifest, expandedBytes: 4 }))).toBe(
    "manifest_mismatch",
  );
  expect(await errorCode(commit(paths, { ...manifest, maxEntryBytes: 2 }))).toBe("entry_too_large");
});

test("refuses to move aside when a backup for this migration already exists", async () => {
  const paths = await target();
  await mkdir(paths.workspaceDirectory, { recursive: true });
  await mkdir(join(paths.backupDirectory, `preexisting-${migration.migrationId}`), {
    recursive: true,
  });
  const manifest = await transfer(await sourceWorkspace({ "MEMORY.md": "m" }), paths);
  expect(await errorCode(commit(paths, manifest))).toBe("backup_conflict");
  // The workspace that was there stays where it was.
  expect((await stat(paths.workspaceDirectory)).isDirectory()).toBe(true);
});

test("stops unpacking as soon as the archive outgrows its manifest", async () => {
  const paths = await target();
  const manifest = await craftedBundle(
    [
      { name: "workspace/a.txt", content: "a" },
      { name: "workspace/b.txt", content: "b" },
    ],
    paths,
  );
  expect(await errorCode(commit(paths, { ...manifest, entryCount: 1 }))).toBe("manifest_mismatch");
  expect(await errorCode(commit(paths, { ...manifest, expandedBytes: 1 }))).toBe(
    "manifest_mismatch",
  );
});

test("refuses an entry with no type", async () => {
  const paths = await target();
  const manifest = await craftedBundle([{ name: "workspace/a.txt", type: "directory" }], paths);
  expect(await errorCode(commit(paths, manifest))).toBe("unsupported_entry");
});

test("refuses paths that differ only in case, which a case-insensitive disk would merge", async () => {
  const paths = await target();
  const manifest = await craftedBundle(
    [
      { name: "workspace/a/b/c/d/e", type: "symlink", linkname: "../../.." },
      { name: "workspace/A/B/C/D/E/q/L", type: "symlink", linkname: "../../../../.." },
      { name: "workspace/A/B/C/D/E/q/l/evil.txt", content: "escaped" },
    ],
    paths,
  );
  expect(await errorCode(commit(paths, manifest))).toBe("unsafe_path");
  expect(await Bun.file(paths.workspaceDirectory).exists()).toBe(false);
  expect(await Bun.file(join(dirname(paths.migrationDirectory), "evil.txt")).exists()).toBe(false);
});

test("refuses the commit directory in another case and an entry under a file", async () => {
  const reserved = await target();
  const upper = await craftedBundle(
    [{ name: "workspace/.COFORGE-MIGRATION/x", content: "x" }],
    reserved,
  );
  expect(await errorCode(commit(reserved, upper))).toBe("reserved_path");

  const nested = await target();
  const underFile = await craftedBundle(
    [
      { name: "workspace/a", content: "file" },
      { name: "workspace/a/b", content: "child" },
    ],
    nested,
  );
  expect(await errorCode(commit(nested, underFile))).toBe("unsafe_path");
});

test("a refused entry ends a many-chunk unpack promptly instead of hanging", async () => {
  const source = await sourceWorkspace({ "a.txt": "a" });
  const paths = await target();
  const tar = pack();
  const big = "y".repeat(4 * MiB);
  // Read the tar while writing it: a large entry fills the pack's buffer otherwise.
  const parts: Buffer[] = [];
  const collected = (async () => {
    for await (const part of tar) parts.push(part as Buffer);
  })();
  await new Promise<void>((resolve, reject) =>
    tar.entry({ name: "workspace/../escape", size: 1 }, "x", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  await new Promise<void>((resolve, reject) =>
    tar.entry({ name: "workspace/big.txt", size: big.length }, big, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  tar.finalize();
  await collected;
  // Stored uncompressed-sized gzip (level 0) so the bundle spans many chunks.
  const bytes = new Uint8Array(Bun.gzipSync(new Uint8Array(Buffer.concat(parts)), { level: 0 }));
  const chunks = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += 64 * 1024, index += 1) {
    const part = bytes.subarray(offset, offset + 64 * 1024);
    const chunk = {
      index,
      offsetBytes: offset,
      sizeBytes: part.byteLength,
      sha256: Bun.CryptoHasher.hash("sha256", part, "hex") as string,
    };
    await storeAgentMigrationChunk(paths.migrationDirectory, chunk, part);
    chunks.push(chunk);
  }
  void source;
  const manifest = {
    ...(await craftedBundle([], await target())),
    entryCount: 2,
    expandedBytes: big.length + 1,
    maxEntryBytes: big.length,
    sizeBytes: bytes.byteLength,
    sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") as string,
    chunks,
  };
  expect(await errorCode(commit(paths, manifest))).toBe("unsafe_path");
}, 10_000);

test("strips setuid and setgid bits; only permission bits travel", async () => {
  const paths = await target();
  const tar = pack();
  await new Promise<void>((resolve, reject) =>
    tar.entry({ name: "workspace/tool", size: 1, mode: 0o6755 }, "x", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  tar.finalize();
  const parts: Buffer[] = [];
  for await (const part of tar) parts.push(part as Buffer);
  const bytes = new Uint8Array(Bun.gzipSync(new Uint8Array(Buffer.concat(parts))));
  const chunk = {
    index: 0,
    offsetBytes: 0,
    sizeBytes: bytes.byteLength,
    sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") as string,
  };
  await storeAgentMigrationChunk(paths.migrationDirectory, chunk, bytes);
  const manifest = {
    ...(await craftedBundle([], await target())),
    entryCount: 1,
    expandedBytes: 1,
    maxEntryBytes: 1,
    sizeBytes: bytes.byteLength,
    sha256: chunk.sha256,
    chunks: [chunk],
  };
  await commit(paths, manifest);
  expect((await stat(join(paths.workspaceDirectory, "tool"))).mode & 0o7777).toBe(0o755);
});

test("rollback restores a workspace when its backup is on another filesystem", async () => {
  const paths = await target();
  await mkdir(paths.workspaceDirectory, { recursive: true });
  await Bun.write(join(paths.workspaceDirectory, "MEMORY.md"), "old target");
  const source = await sourceWorkspace({ "MEMORY.md": "moved" });
  await commit(paths, await transfer(source, paths));
  const rename = fileSystem.rename;
  const renameAcrossDevices = spyOn(fileSystem, "rename").mockImplementation(async (from, to) => {
    if (
      String(from).startsWith(paths.backupDirectory + sep) &&
      !String(to).startsWith(paths.backupDirectory + sep)
    ) {
      throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
    }
    await rename(from, to);
  });
  try {
    await rollBackAgentMigrationPlacement({ ...paths, ...migration });
    expect(await Bun.file(join(paths.workspaceDirectory, "MEMORY.md")).text()).toBe("old target");
  } finally {
    renameAcrossDevices.mockRestore();
  }
});
