import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMigrationBundleManifest } from "./bundle-writer";
import { AgentMigrationCommitError } from "./commit-error";

/**
 * The target Computer's store of downloaded bundle chunks, one file per chunk under a migration
 * attempt's directory. It owns their layout: a chunk is verified before it is kept, written beside
 * its final name and renamed into place, so a stored chunk is always whole, and a retried download
 * can skip one already stored. As in the reference Computer, a stored chunk that does not match
 * its manifest entry is an error rather than something to overwrite.
 */

export type AgentMigrationChunkReference = Pick<
  AgentMigrationBundleManifest["chunks"][number],
  "index" | "sizeBytes" | "sha256"
>;

const chunksDirectory = (migrationDirectory: string) => join(migrationDirectory, "chunks");
const chunkPath = (migrationDirectory: string, index: number) =>
  join(chunksDirectory(migrationDirectory), `${index}.chunk`);

const isChunk = (bytes: Uint8Array, chunk: AgentMigrationChunkReference) =>
  bytes.byteLength === chunk.sizeBytes &&
  Bun.CryptoHasher.hash("sha256", bytes, "hex") === chunk.sha256;

/** The stored chunk's bytes, or null when it has not been stored. */
async function readStored(migrationDirectory: string, chunk: AgentMigrationChunkReference) {
  const bytes = await Bun.file(chunkPath(migrationDirectory, chunk.index))
    .bytes()
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    });
  if (bytes && !isChunk(bytes, chunk))
    throw new AgentMigrationCommitError("chunk_digest_mismatch", `stored chunk ${chunk.index}`);
  return bytes;
}

/** Whether this chunk is already stored and whole, so a download can skip it. */
export async function hasAgentMigrationChunk(
  migrationDirectory: string,
  chunk: AgentMigrationChunkReference,
) {
  return (await readStored(migrationDirectory, chunk)) !== null;
}

/** Keeps a downloaded chunk if it is the one the manifest names; reuses one already stored. */
export async function storeAgentMigrationChunk(
  migrationDirectory: string,
  chunk: AgentMigrationChunkReference,
  bytes: Uint8Array,
): Promise<"stored" | "reused"> {
  if (!isChunk(bytes, chunk))
    throw new AgentMigrationCommitError("chunk_digest_mismatch", `chunk ${chunk.index}`);
  if (await readStored(migrationDirectory, chunk)) return "reused";
  await mkdir(chunksDirectory(migrationDirectory), { recursive: true, mode: 0o700 });
  const partial = join(
    chunksDirectory(migrationDirectory),
    `.partial-${chunk.index}-${crypto.randomUUID()}`,
  );
  try {
    await writeFile(partial, bytes, { mode: 0o600, flag: "wx" });
    await rename(partial, chunkPath(migrationDirectory, chunk.index));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return "stored";
}

/** A stored chunk's bytes, verified again, for unpacking. */
export async function readVerifiedAgentMigrationChunk(
  migrationDirectory: string,
  chunk: AgentMigrationChunkReference,
) {
  const bytes = await readStored(migrationDirectory, chunk);
  if (!bytes) throw new AgentMigrationCommitError("chunks_missing", `chunk ${chunk.index}`);
  return bytes;
}
