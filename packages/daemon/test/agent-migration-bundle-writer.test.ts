import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  unlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extract } from "tar-stream";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AgentMigrationBundleLimitError,
  writeAgentMigrationBundle,
  type AgentMigrationBundleChunk,
} from "#src/agent-migration/bundle-writer";
import {
  selectAgentMigrationWorkspace,
  type AgentMigrationWorkspaceSelection,
} from "#src/agent-migration/workspace-selection";

const MiB = 1024 * 1024;
const tempRoot = realpathSync(tmpdir());
const roots: string[] = [];
const locked: string[] = [];

afterEach(async () => {
  await Promise.all(locked.splice(0).map((path) => chmod(path, 0o644)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Permission bits do not stop root, so the unreadable-file case only holds for a normal user.
const asUser = process.getuid?.() === 0 ? test.skip : test;

async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tempRoot, "agent-migration-bundle-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await Bun.write(join(root, path), content);
  }
  return root;
}

/** Text that does not compress, so a bundle of it spans several chunks. */
const incompressible = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(Math.ceil((bytes * 3) / 4))))
    .toString("base64")
    .slice(0, bytes);

const sha256 = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

type PackOptions = {
  selection?: AgentMigrationWorkspaceSelection;
  chunkBytes?: number;
  maxBytes?: number;
  maxEntries?: number;
  onChunk?: (chunk: AgentMigrationBundleChunk) => Promise<void>;
};

async function pack(root: string, options: PackOptions = {}) {
  const chunks: AgentMigrationBundleChunk[] = [];
  const { selection = await selectAgentMigrationWorkspace(root), onChunk, ...limits } = options;
  // Small test chunks get a limit they can actually be cut into (at most 2048 chunks).
  if (limits.chunkBytes && !limits.maxBytes) limits.maxBytes = limits.chunkBytes * 64;
  const written = await writeAgentMigrationBundle({
    workspaceDirectory: root,
    selection,
    ...limits,
    onChunk: async (chunk) => {
      await onChunk?.(chunk);
      chunks.push(chunk);
    },
  });
  chunks.sort((left, right) => left.index - right.index);
  const bundle = new Uint8Array(Buffer.concat(chunks.map((chunk) => chunk.bytes)));
  return { ...written, chunks, bundle };
}

type Unpacked = { type: string; mode: number; mtimeMs: number; linkname?: string; text: string };

/** Reads a bundle back the way a target would, independently of the writer, keyed by name. */
async function unpack(bundle: Uint8Array): Promise<Map<string, Unpacked>> {
  const entries = new Map<string, Unpacked>();
  const reader = extract();
  const done = new Promise<void>((resolve, reject) => {
    reader.on("entry", (header, stream, next) => {
      const parts: Buffer[] = [];
      stream.on("data", (part: unknown) => {
        parts.push(part as Buffer);
      });
      stream.on("end", () => {
        entries.set(header.name, {
          type: header.type ?? "file",
          mode: header.mode ?? 0,
          mtimeMs: header.mtime?.getTime() ?? 0,
          ...(header.linkname ? { linkname: header.linkname } : {}),
          text: Buffer.concat(parts).toString("utf8"),
        });
        next();
      });
      stream.resume();
    });
    reader.on("finish", resolve);
    reader.on("error", reject);
  });
  reader.end(Buffer.from(Bun.gunzipSync(new Uint8Array(bundle))));
  await done;
  return entries;
}

test("packs the selected files and symlinks under workspace/ with their modes and times", async () => {
  const root = await workspace({
    "MEMORY.md": "# memory",
    "notes/a.md": "a",
    "bin/run.sh": "#!/bin/sh\necho hi\n",
    ".env": "SECRET=1",
  });
  await chmod(join(root, "bin/run.sh"), 0o755);
  await chmod(join(root, "notes/a.md"), 0o600);
  const fixed = new Date("2026-10-01T08:00:00.000Z");
  await utimes(join(root, "MEMORY.md"), fixed, fixed);
  await symlink("bin/run.sh", join(root, "run"));

  const { manifest, bundle } = await pack(root);
  const entries = await unpack(bundle);

  expect([...entries.keys()]).toEqual([
    "workspace/MEMORY.md",
    "workspace/bin/run.sh",
    "workspace/notes/a.md",
    "workspace/run",
  ]);
  expect(entries.get("workspace/MEMORY.md")).toMatchObject({
    type: "file",
    text: "# memory",
    mtimeMs: fixed.getTime(),
  });
  expect(entries.get("workspace/bin/run.sh")!.mode & 0o777).toBe(0o755);
  expect(entries.get("workspace/notes/a.md")!.mode & 0o777).toBe(0o600);
  expect(entries.get("workspace/run")).toMatchObject({ type: "symlink", linkname: "bin/run.sh" });
  expect(manifest).toMatchObject({
    format: "tar+gzip",
    contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
    entryCount: 4,
    expandedBytes: 8 + 1 + 18,
    maxEntryBytes: 18,
    memoryMdPresent: true,
    notesPresent: true,
  });
});

test("streams a file larger than the in-memory threshold intact", async () => {
  const large = incompressible(1.5 * MiB);
  const root = await workspace({ "data/large.txt": large });
  const entries = await unpack((await pack(root)).bundle);
  expect(entries.get("workspace/data/large.txt")!.text).toBe(large);
});

test("cuts the stream into chunks whose offsets, digests and sizes add up to the whole bundle", async () => {
  const root = await workspace({
    "a.bin": incompressible(2 * MiB),
    "b.bin": incompressible(2 * MiB),
  });

  const { manifest, chunks, bundle } = await pack(root, { chunkBytes: MiB });

  expect(chunks.length).toBeGreaterThan(2);
  expect(manifest.chunkSizeBytes).toBe(MiB);
  let offset = 0;
  manifest.chunks.forEach((chunk, index) => {
    expect(chunk).toEqual({
      index,
      offsetBytes: offset,
      sizeBytes: chunks[index]!.sizeBytes,
      sha256: sha256(chunks[index]!.bytes),
    });
    if (index < manifest.chunks.length - 1) expect(chunk.sizeBytes).toBe(MiB);
    offset += chunk.sizeBytes;
  });
  expect(manifest.sizeBytes).toBe(bundle.byteLength);
  expect(manifest.sha256).toBe(sha256(bundle));
});

test("keeps at most three chunks in the hands of the consumer at once", async () => {
  const root = await workspace({ "a.bin": incompressible(5 * MiB) });
  let inFlight = 0;
  let peak = 0;
  await pack(root, {
    chunkBytes: MiB,
    onChunk: async () => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(150);
      inFlight -= 1;
    },
  });
  expect(peak).toBe(3);
});

test("packs an unchanged workspace to the same bytes every time", async () => {
  const root = await workspace({ "MEMORY.md": "m", "notes/a.md": "a", "src/main.ts": "export {}" });
  expect((await pack(root)).manifest.sha256).toBe((await pack(root)).manifest.sha256);
});

test("stops once the compressed bundle would exceed its size limit, without passing the limit on", async () => {
  const root = await workspace({ "big.bin": incompressible(4 * MiB) });
  let handedOver = 0;
  const error = await pack(root, {
    chunkBytes: MiB,
    maxBytes: 1.5 * MiB,
    onChunk: async (chunk) => {
      handedOver += chunk.sizeBytes;
    },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AgentMigrationBundleLimitError);
  expect((error as AgentMigrationBundleLimitError).limit).toBe("bundle_bytes");
  expect(handedOver).toBeLessThanOrEqual(1.5 * MiB);
});

test("refuses limits that would need more than 2048 chunks, or chunks under 1 MiB", async () => {
  const root = await workspace({ "a.txt": "a" });
  await expect(pack(root, { chunkBytes: MiB, maxBytes: 3 * 1024 * MiB })).rejects.toThrow(/2048/);
  await expect(pack(root, { chunkBytes: 4096 })).rejects.toThrow(/1 MiB/);
});

test("refuses a selection with more entries than the limit, naming the largest top-level paths", async () => {
  const root = await workspace({
    "src/a.ts": "a",
    "src/b.ts": "b",
    "src/c.ts": "c",
    "notes/n.md": "n",
    "secrets.json": "{}",
  });
  // A selection made outside the default rules can still carry a secret-looking name.
  const selection = await selectAgentMigrationWorkspace(root);
  selection.entries.push({ path: "secrets.json", kind: "file", sizeBytes: 2 });
  const error = await pack(root, { selection, maxEntries: 3 }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AgentMigrationBundleLimitError);
  expect((error as AgentMigrationBundleLimitError).limit).toBe("entry_count");
  expect((error as AgentMigrationBundleLimitError).largestTopLevelPaths).toEqual([
    { path: "src", entryCount: 3 },
    { path: "notes", entryCount: 1 },
    { path: "other/", entryCount: 1 },
  ]);
});

test("packs a file at its size when it is packed, so an append after selection arrives whole", async () => {
  const root = await workspace({ "MEMORY.md": "# memory\n" });
  const selection = await selectAgentMigrationWorkspace(root);
  await appendFile(join(root, "MEMORY.md"), "- a later note\n");

  const { drift, manifest, bundle } = await pack(root, { selection });

  expect((await unpack(bundle)).get("workspace/MEMORY.md")!.text).toBe(
    "# memory\n- a later note\n",
  );
  expect(drift.resized).toEqual([]);
  expect(manifest.expandedBytes).toBe(24);
});

test("zero-pads a large file that shrinks while it is being streamed, and reports it", async () => {
  const size = 3 * MiB;
  const root = await workspace({ "big.txt": incompressible(size) });
  let cut = false;
  const { drift, bundle } = await pack(root, {
    chunkBytes: MiB,
    onChunk: async () => {
      if (cut) return;
      cut = true;
      await truncate(join(root, "big.txt"), 1024);
    },
  });
  const text = (await unpack(bundle)).get("workspace/big.txt")!.text;
  expect(text.length).toBe(size);
  expect(text.endsWith("\0".repeat(1024))).toBe(true);
  expect(drift.resized).toEqual(["big.txt"]);
});

test("re-reads a symlink's target when packing and stores it normalized", async () => {
  const root = await workspace({ "a.txt": "a", "b.txt": "b", "notes/c.md": "c" });
  await symlink("a.txt", join(root, "link"));
  await symlink("notes/../b.txt", join(root, "tidy"));
  const selection = await selectAgentMigrationWorkspace(root);
  await unlink(join(root, "link"));
  await symlink("./notes/c.md", join(root, "link"));

  const { drift, bundle } = await pack(root, { selection });
  const entries = await unpack(bundle);

  expect(entries.get("workspace/link")).toMatchObject({ type: "symlink", linkname: "notes/c.md" });
  expect(entries.get("workspace/tidy")).toMatchObject({ type: "symlink", linkname: "b.txt" });
  expect(drift.skipped).toEqual([]);
});

test("skips a symlink retargeted outside the workspace after selection", async () => {
  const root = await workspace({ "a.txt": "a" });
  await symlink("a.txt", join(root, "link"));
  const selection = await selectAgentMigrationWorkspace(root);
  await unlink(join(root, "link"));
  await symlink("../outside", join(root, "link"));

  const { drift, bundle } = await pack(root, { selection });
  expect([...(await unpack(bundle)).keys()]).toEqual(["workspace/a.txt"]);
  expect(drift.skipped).toEqual(["link"]);
});

test("skips a selected file that is gone or became a symlink by the time it is packed", async () => {
  const root = await workspace({ "keep.txt": "k", "gone.txt": "g", "swapped.txt": "s" });
  const selection = await selectAgentMigrationWorkspace(root);
  await rm(join(root, "gone.txt"));
  await rm(join(root, "swapped.txt"));
  await symlink("keep.txt", join(root, "swapped.txt"));

  const { manifest, drift, bundle } = await pack(root, { selection });

  expect([...(await unpack(bundle)).keys()]).toEqual(["workspace/keep.txt"]);
  expect(manifest.entryCount).toBe(1);
  expect(drift.skipped).toEqual(["gone.txt", "swapped.txt"]);
});

asUser("fails the bundle on a selected file it cannot read, rather than dropping it", async () => {
  const root = await workspace({ "keep.txt": "k", "locked.txt": "l" });
  const selection = await selectAgentMigrationWorkspace(root);
  locked.push(join(root, "locked.txt"));
  await chmod(join(root, "locked.txt"), 0o000);
  await expect(pack(root, { selection })).rejects.toMatchObject({ code: "EACCES" });
});
