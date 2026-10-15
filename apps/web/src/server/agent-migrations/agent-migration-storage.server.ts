import {
  createFileStorage,
  FileStorageConfigError,
  readFileStorageConfig,
  type FileStorageConfig,
} from "#src/server/files/file-storage.server";
import type { AgentMigrationObjectStore } from "./agent-migration-transport.server";

/**
 * Where an Agent migration's workspace bundle travels between two Computers: a bucket of its own,
 * so the daemons' presigned URLs and the bucket's short lifecycle rule never touch user files.
 *
 * Env, in addition to the private store's (`file-storage.server.ts`):
 * - `COFORGE_MIGRATION_OSS_BUCKET` — the migration bucket, in the same account and region as the
 *   private files bucket and never equal to it. Unset means this deployment cannot move an Agent's
 *   workspace between Computers, which is the local-development and pre-provisioning state.
 */
export async function readAgentMigrationStorageConfig(
  env: NodeJS.ProcessEnv,
): Promise<FileStorageConfig | null> {
  const bucket = env.COFORGE_MIGRATION_OSS_BUCKET?.trim();
  if (!bucket) return null;
  const privateStore = await readFileStorageConfig(env);
  if (privateStore.kind !== "oss") {
    throw new FileStorageConfigError(
      "COFORGE_MIGRATION_OSS_BUCKET requires COFORGE_FILE_STORAGE=oss",
    );
  }
  if (privateStore.bucket === bucket) {
    throw new FileStorageConfigError(
      "COFORGE_MIGRATION_OSS_BUCKET must not be COFORGE_OSS_BUCKET: migration bundles expire within days",
    );
  }
  return { ...privateStore, bucket };
}

let current: Promise<AgentMigrationObjectStore | null> | undefined;

/** The process-wide migration bucket, or `null` when this deployment has none. */
export function getAgentMigrationStorage(): Promise<AgentMigrationObjectStore | null> {
  current ??= createAgentMigrationStorage().catch((error: unknown) => {
    // Not cached: a request after a failed read (say, a Docker secret not yet mounted) reads again.
    current = undefined;
    throw error;
  });
  return current;
}

async function createAgentMigrationStorage(): Promise<AgentMigrationObjectStore | null> {
  const config = await readAgentMigrationStorageConfig(Bun.env);
  if (!config) return null;
  const storage = await createFileStorage(config);
  if (!storage.presignPut || !storage.presignGet)
    throw new FileStorageConfigError("the migration bucket must support presigned URLs");
  return storage as AgentMigrationObjectStore;
}
