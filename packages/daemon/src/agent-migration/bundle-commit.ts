import { mkdir, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { Writable } from "streamx";
import { extract } from "tar-stream";
import { AGENT_MIGRATION_BUNDLE_ROOT, type AgentMigrationBundleManifest } from "./bundle-writer";
import { readVerifiedAgentMigrationChunk } from "./chunk-store";
import { AgentMigrationCommitError } from "./commit-error";
import { exists, moveWorkspaceToBackup, preexistingBackupName } from "./workspace-backups";
import {
  AGENT_MIGRATION_COMMIT_DIRECTORY,
  isSafeRelativePath,
  isWorkspaceSymlinkTarget,
} from "./selection-rules";

/**
 * Places a transferred bundle as an Agent's workspace on the target Computer, following the
 * reference Computer: every chunk and the whole bundle are verified again as they are read; the
 * archive is unpacked into a staging directory beside the chunks with every path, link and entry
 * type checked and its running totals held to the manifest; a commit marker is written; and the
 * staged workspace is renamed into place in one step. A workspace already at that path is moved
 * aside intact, unless it is this same migration's committed copy, which makes a retried commit a
 * no-op, and never while the Agent is running there.
 */

export const AGENT_MIGRATION_COMMIT_MARKER = `${AGENT_MIGRATION_COMMIT_DIRECTORY}/commit-v1.json`;
const COMMIT_MARKER_SCHEMA = "coforge.agent-migration-commit/v1";

type MigrationIdentity = { agentId: string; migrationId: string; generation: number };

type CommitMarker = MigrationIdentity & {
  schema: typeof COMMIT_MARKER_SCHEMA;
  bundleSha256: string;
  committedAt: string;
};

export type AgentMigrationCommitOutcome =
  | { outcome: "committed"; movedAsideTo?: string }
  | { outcome: "already_committed" };

async function readMarker(workspaceDirectory: string): Promise<CommitMarker | null> {
  try {
    const bytes = await Bun.file(
      join(workspaceDirectory, AGENT_MIGRATION_COMMIT_MARKER),
    ).arrayBuffer();
    // BunFile.text() strips a BOM; keep it so JSON.parse rejects the same damaged markers.
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
}

function isThisCommit(marker: CommitMarker | null, identity: MigrationIdentity, sha256: string) {
  return (
    marker?.schema === COMMIT_MARKER_SCHEMA &&
    marker.agentId === identity.agentId &&
    marker.migrationId === identity.migrationId &&
    marker.generation === identity.generation &&
    marker.bundleSha256 === sha256
  );
}

/**
 * Which placement the workspace is, by its commit marker: `<migrationId>:<generation>`, or `""`
 * for a workspace no migration placed. Lets a source tell the workspace it uploaded from one a
 * later migration has since placed in the same directory.
 */
export async function agentWorkspacePlacement(workspaceDirectory: string) {
  const marker = await readMarker(workspaceDirectory);
  return marker?.schema === COMMIT_MARKER_SCHEMA
    ? `${marker.migrationId}:${marker.generation}`
    : "";
}

/**
 * What the archive has placed so far, keyed by case-folded, NFC-normalized path: a
 * case-insensitive or normalizing disk (macOS by default) would merge names differing only in
 * case or normalization, so two of them must never both land, nor one land under a link or file
 * whose name only differs in case.
 */
class PlacedPaths {
  readonly #entries = new Set<string>();
  readonly #directories = new Set<string>();

  static fold(path: string) {
    return path.normalize("NFC").toLowerCase();
  }

  /** The workspace-relative path of an archive entry, or a refusal naming why it may not land. */
  admit(name: string) {
    const prefix = `${AGENT_MIGRATION_BUNDLE_ROOT}/`;
    const path = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    if (!isSafeRelativePath(path)) throw new AgentMigrationCommitError("unsafe_path", name);
    const folded = PlacedPaths.fold(path);
    const segments = folded.split("/");
    if (segments[0] === AGENT_MIGRATION_COMMIT_DIRECTORY.toLowerCase())
      throw new AgentMigrationCommitError("reserved_path", name);
    if (this.#entries.has(folded) || this.#directories.has(folded))
      throw new AgentMigrationCommitError("unsafe_path", `${name} collides with another entry`);
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join("/");
      if (this.#entries.has(ancestor))
        throw new AgentMigrationCommitError("unsafe_path", `${name} lies under a link or file`);
      this.#directories.add(ancestor);
    }
    this.#entries.add(folded);
    return path;
  }
}

/** Stored chunks in order, each re-verified, as one byte stream; also hashes the whole bundle. */
function verifiedChunks(migrationDirectory: string, manifest: AgentMigrationBundleManifest) {
  const bundleHash = new Bun.CryptoHasher("sha256");
  let sizeBytes = 0;
  let next = 0;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const chunk = manifest.chunks[next++];
      if (!chunk) {
        controller.close();
        return;
      }
      const bytes = await readVerifiedAgentMigrationChunk(migrationDirectory, chunk);
      bundleHash.update(bytes);
      sizeBytes += bytes.byteLength;
      controller.enqueue(bytes);
    },
  });
  return { stream, digest: () => ({ sha256: bundleHash.digest("hex"), sizeBytes }) };
}

/** Unpacks the verified bundle into `destination`, checking every entry; returns its totals. */
async function unpack(
  migrationDirectory: string,
  manifest: AgentMigrationBundleManifest,
  destination: string,
) {
  const chunks = verifiedChunks(migrationDirectory, manifest);
  const reader = extract();
  const admitted = new PlacedPaths();
  const realDestination = await realpath(destination);
  const directories = new Set<string>([destination]);
  const totals = { entryCount: 0, expandedBytes: 0 };

  /** Creates an entry's parent and confirms, on disk, that it really lies inside the staging. */
  const ensureDirectory = async (path: string) => {
    if (directories.has(path)) return;
    await mkdir(path, { recursive: true, mode: 0o755 });
    const real = await realpath(path);
    if (real !== realDestination && !real.startsWith(realDestination + sep))
      throw new AgentMigrationCommitError("unsafe_path", `${path} resolves outside the workspace`);
    directories.add(path);
  };

  const feed = async () => {
    try {
      const decompressed = chunks.stream.pipeThrough(new DecompressionStream("gzip"));
      for await (const data of decompressed as unknown as AsyncIterable<Uint8Array>) {
        if (
          !reader.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength)) &&
          !(await Writable.drained(reader))
        )
          throw new Error("the archive reader closed before it drained");
      }
      // streamx's `end` writes nothing for `undefined`; its typings just require the argument.
      reader.end(undefined);
    } catch (error) {
      reader.destroy(error as Error);
      throw error;
    }
  };

  const place = async () => {
    try {
      for await (const entry of reader) {
        const { header } = entry;
        if (header.type !== "file" && header.type !== "symlink")
          throw new AgentMigrationCommitError(
            "unsupported_entry",
            `${header.name} is a ${header.type ?? "typeless entry"}`,
          );
        const path = admitted.admit(header.name);
        const target = join(destination, path);
        // Refuse as soon as the archive outgrows its manifest, before it can fill the disk.
        if (++totals.entryCount > manifest.entryCount)
          throw new AgentMigrationCommitError(
            "manifest_mismatch",
            "more entries than the manifest",
          );
        await ensureDirectory(dirname(target));
        if (header.type === "symlink") {
          const linkTarget = header.linkname ?? "";
          if (
            posix.normalize(linkTarget) !== linkTarget ||
            !isWorkspaceSymlinkTarget(destination, dirname(target), linkTarget)
          )
            throw new AgentMigrationCommitError("unsafe_link", `${header.name} -> ${linkTarget}`);
          await symlink(linkTarget, target);
          entry.resume();
        } else {
          const size = header.size;
          if (!Number.isSafeInteger(size) || size! < 0)
            throw new AgentMigrationCommitError("unsupported_entry", `${header.name} has no size`);
          if (size! > manifest.maxEntryBytes)
            throw new AgentMigrationCommitError(
              "entry_too_large",
              `${header.name} is ${size} bytes`,
            );
          totals.expandedBytes += size!;
          if (totals.expandedBytes > manifest.expandedBytes)
            throw new AgentMigrationCommitError(
              "manifest_mismatch",
              "more bytes than the manifest",
            );
          const handle = await open(target, "wx", 0o600);
          try {
            for await (const data of entry as AsyncIterable<Buffer>) await handle.write(data);
            // Only the permission bits travel; a missing mode falls back to owner-only.
            await handle.chmod((header.mode ?? 0o600) & 0o777);
            if (header.mtime) await handle.utimes(header.mtime, header.mtime);
          } finally {
            await handle.close();
          }
        }
      }
    } catch (error) {
      // Stop the feeder too: it may be waiting for the reader to drain.
      reader.destroy(error as Error);
      throw error;
    }
  };

  const [fed, placed] = await Promise.allSettled([feed(), place()]);
  // An entry check names what was wrong; the stream failure it then causes is secondary.
  if (placed.status === "rejected") throw placed.reason;
  if (fed.status === "rejected") throw fed.reason;
  return { ...totals, ...chunks.digest() };
}

/**
 * Undoes this migration's placement on the target when the switch did not land: the placed
 * workspace goes, and the workspace it moved aside comes back. A workspace that does not carry this
 * migration's marker is left alone, since it is not one this placement put there.
 */
export async function rollBackAgentMigrationPlacement(
  input: MigrationIdentity & { workspaceDirectory: string; backupDirectory: string },
): Promise<void> {
  const marker = await readMarker(input.workspaceDirectory);
  if (
    marker?.schema !== COMMIT_MARKER_SCHEMA ||
    marker.agentId !== input.agentId ||
    marker.migrationId !== input.migrationId ||
    marker.generation !== input.generation
  )
    return;
  const preexisting = join(input.backupDirectory, preexistingBackupName(input.migrationId));
  // Stage the original beside the workspace before discarding the placed copy. The same verified
  // cross-device move used for backups keeps both copies intact if preparing the restore fails.
  const restored = (await exists(preexisting))
    ? await moveWorkspaceToBackup(
        preexisting,
        dirname(input.workspaceDirectory),
        `rollback-${input.migrationId}-${crypto.randomUUID()}`,
      )
    : undefined;
  await rm(input.workspaceDirectory, { recursive: true, force: true });
  if (restored) await rename(restored, input.workspaceDirectory);
}

export async function commitAgentMigrationBundle(
  input: MigrationIdentity & {
    workspaceDirectory: string;
    /** This migration attempt's directory on the target; holds `chunks/` and the staging area. */
    migrationDirectory: string;
    backupDirectory: string;
    manifest: AgentMigrationBundleManifest;
    /** Whether the Agent has a process on this Computer; its workspace is then never moved. */
    agentRunning: boolean;
  },
): Promise<AgentMigrationCommitOutcome> {
  const { manifest } = input;
  if (await exists(input.workspaceDirectory)) {
    if (isThisCommit(await readMarker(input.workspaceDirectory), input, manifest.sha256))
      return { outcome: "already_committed" };
    if (input.agentRunning)
      throw new AgentMigrationCommitError(
        "workspace_in_use",
        "the Agent is running in the workspace on this Computer",
      );
  }

  const staging = join(input.migrationDirectory, `extracting-${crypto.randomUUID()}`);
  const staged = join(staging, "workspace");
  try {
    await mkdir(staged, { recursive: true, mode: 0o700 });
    const unpacked = await unpack(input.migrationDirectory, manifest, staged);
    if (unpacked.sha256 !== manifest.sha256 || unpacked.sizeBytes !== manifest.sizeBytes)
      throw new AgentMigrationCommitError(
        "bundle_digest_mismatch",
        "the chunks do not add up to the bundle",
      );
    if (
      unpacked.entryCount !== manifest.entryCount ||
      unpacked.expandedBytes !== manifest.expandedBytes
    )
      throw new AgentMigrationCommitError(
        "manifest_mismatch",
        `${unpacked.entryCount} entries and ${unpacked.expandedBytes} bytes, not ${manifest.entryCount} and ${manifest.expandedBytes}`,
      );
    const marker: CommitMarker = {
      schema: COMMIT_MARKER_SCHEMA,
      agentId: input.agentId,
      migrationId: input.migrationId,
      generation: input.generation,
      bundleSha256: manifest.sha256,
      committedAt: new Date().toISOString(),
    };
    await mkdir(join(staged, AGENT_MIGRATION_COMMIT_DIRECTORY), { mode: 0o700 });
    await writeFile(join(staged, AGENT_MIGRATION_COMMIT_MARKER), `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
      flag: "wx",
    });

    const movedAsideTo = (await exists(input.workspaceDirectory))
      ? await moveWorkspaceToBackup(
          input.workspaceDirectory,
          input.backupDirectory,
          preexistingBackupName(input.migrationId),
        )
      : undefined;
    await mkdir(dirname(input.workspaceDirectory), { recursive: true });
    try {
      await rename(staged, input.workspaceDirectory);
    } catch (error) {
      // Never leave the Agent without the workspace that was there: put it back.
      if (movedAsideTo && !(await exists(input.workspaceDirectory)))
        await rename(movedAsideTo, input.workspaceDirectory).catch(() => {});
      // Placed by a concurrent commit of this same migration in the meantime.
      if (isThisCommit(await readMarker(input.workspaceDirectory), input, manifest.sha256))
        return { outcome: "already_committed" };
      if (["EEXIST", "ENOTEMPTY"].includes((error as { code?: string }).code ?? ""))
        throw new AgentMigrationCommitError(
          "workspace_already_exists",
          "another workspace appeared while this one was being placed",
        );
      throw error;
    }
    return movedAsideTo ? { outcome: "committed", movedAsideTo } : { outcome: "committed" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
