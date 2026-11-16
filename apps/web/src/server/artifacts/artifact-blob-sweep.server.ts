import { requireDatabaseClient } from "#src/server/db/client.server";
import { errorType } from "#src/server/errors/error-type.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { StoredArtifactBlobs } from "./artifact-blobs.server";
import { sweepExpiredDrafts } from "./artifact-comment-draft-sweep.server";

export const ARTIFACT_BLOB_SWEEP_MS = 60 * 60 * 1000;

let started = false;
let sweeping = false;

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
    const db = requireDatabaseClient();
    const blobs = new StoredArtifactBlobs(db, getFileStorage);
    const drafts = await sweepExpiredDrafts(db, blobs);
    if (drafts) console.info(JSON.stringify({ event: "artifact_drafts:swept", removed: drafts }));
    const removed = await blobs.removeUnreferenced();
    if (removed) console.info(JSON.stringify({ event: "artifact_blobs:swept", removed }));
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "artifact_blobs:sweep_failed", error_type: errorType(error) }),
    );
  } finally {
    sweeping = false;
  }
}
