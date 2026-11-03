import { requireDatabaseClient } from "#src/server/db/client.server";
import { errorType } from "#src/server/errors/error-type.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { StoredArtifactBlobs } from "./artifact-blobs.server";

/** How often unused artifact blobs are looked for; one waits at most this long past its day. */
export const ARTIFACT_BLOB_SWEEP_MS = 60 * 60 * 1000;

let started = false;
let sweeping = false;

/**
 * Every hour, removes the artifact blobs no version has named for a day (task #385). Every web
 * instance runs it: rows a save or another instance holds are skipped, so two never remove the
 * same blob. A failed run is logged and the next one tries again.
 */
export function ensureArtifactBlobSweep(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => void sweep(), ARTIFACT_BLOB_SWEEP_MS);
  timer.unref();
  onServerShutdown(() => clearInterval(timer));
}

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const removed = await new StoredArtifactBlobs(
      requireDatabaseClient(),
      getFileStorage,
    ).removeUnreferenced();
    if (removed) console.info(JSON.stringify({ event: "artifact_blobs:swept", removed }));
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "artifact_blobs:sweep_failed", error_type: errorType(error) }),
    );
  } finally {
    sweeping = false;
  }
}
