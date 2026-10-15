import { getLogger } from "@logtape/logtape";
import type { AgentMigrationBundleChunk } from "./bundle-writer";
import {
  hasAgentMigrationChunk,
  storeAgentMigrationChunk,
  type AgentMigrationChunkReference,
} from "./chunk-store";
import {
  AgentMigrationRemoteError,
  type AgentMigrationBucket,
  type AgentMigrationServer,
} from "./transfer-ports";
import { AgentMigrationTransferError } from "./transfer-error";

/**
 * Moving bundle chunks between this Computer and the migration bucket. As in the reference
 * Computer, every attempt asks the server for a freshly signed URL, retries a transient failure
 * with a short backoff, and stops at the lease's deadline, which also cuts off an attempt that
 * stalls. The target downloads three chunks at a time and keeps each only once it verifies; the
 * first chunk that fails stops the others before they write anything more.
 */

const logger = getLogger(["coforge", "daemon", "agent-migration"]);

const FIRST_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 250;
const DOWNLOAD_CONCURRENCY = 3;

type Ports = { server: AgentMigrationServer; bucket: AgentMigrationBucket };

type Transfer = {
  migrationId: string;
  generation: number;
  /** The lease's expiry, in this Computer's clock. */
  deadline: number;
  signal?: AbortSignal;
};

/** Runs `attempt` until it succeeds, fails for good, the deadline passes, or `signal` aborts. */
async function untilDeadline<T>(
  transfer: Transfer,
  what: string,
  attempt: (signal: AbortSignal) => Promise<T>,
) {
  let backoff = FIRST_BACKOFF_MS;
  for (;;) {
    if (transfer.signal?.aborted) throw new AgentMigrationTransferError("aborted", what);
    const remaining = transfer.deadline - Date.now();
    if (remaining <= 0) {
      logger.warn("agent_migration:lease_expired", { migration_id: transfer.migrationId, what });
      throw new AgentMigrationTransferError("lease_expired", what);
    }
    const expiry = AbortSignal.timeout(remaining);
    const signal = transfer.signal ? AbortSignal.any([transfer.signal, expiry]) : expiry;
    try {
      return await attempt(signal);
    } catch (error) {
      if (transfer.signal?.aborted) throw new AgentMigrationTransferError("aborted", what);
      // The attempt ran into the deadline; the next turn of the loop reports it.
      if (!expiry.aborted) {
        if (!(error instanceof AgentMigrationRemoteError) || !error.retryable) throw error;
        logger.debug("agent_migration:transfer_retry", {
          migration_id: transfer.migrationId,
          what,
          code: error.code,
        });
      }
    }
    await Bun.sleep(Math.max(0, Math.min(backoff, transfer.deadline - Date.now())));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

/** Puts one sealed chunk into the bucket; a chunk the bucket already holds counts as uploaded. */
export async function uploadAgentMigrationChunk(
  ports: Ports,
  input: Transfer & { chunk: AgentMigrationBundleChunk },
) {
  const { bytes, ...chunk } = input.chunk;
  await untilDeadline(input, `upload of chunk ${chunk.index}`, async (signal) => {
    const attempt = { migrationId: input.migrationId, generation: input.generation, chunk };
    await ports.bucket.put(await ports.server.uploadUrl(attempt, signal), bytes, signal);
  });
}

/**
 * Downloads every chunk this Computer does not already hold into the migration attempt's chunk
 * store, three at a time. A chunk whose bytes do not match the manifest fails the download.
 */
export async function downloadAgentMigrationChunks(
  ports: Ports,
  input: Transfer & { chunks: readonly AgentMigrationChunkReference[]; migrationDirectory: string },
) {
  const stop = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
  const transfer = { ...input, signal };
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < input.chunks.length) {
      const chunk = input.chunks[next++]!;
      if (await hasAgentMigrationChunk(input.migrationDirectory, chunk)) continue;
      const bytes = await untilDeadline(
        transfer,
        `download of chunk ${chunk.index}`,
        async (attemptSignal) => {
          const { url } = await ports.server.downloadUrl(
            { migrationId: input.migrationId, generation: input.generation, index: chunk.index },
            attemptSignal,
          );
          return ports.bucket.get(url, chunk.sizeBytes, attemptSignal);
        },
      );
      if (signal.aborted) return;
      await storeAgentMigrationChunk(input.migrationDirectory, chunk, bytes);
    }
  };
  // The first failure is the cause; any after it are the stop it caused.
  let failure: { cause: unknown } | undefined;
  await Promise.all(
    Array.from({ length: DOWNLOAD_CONCURRENCY }, () =>
      worker().catch((error: unknown) => {
        failure ??= { cause: error };
        stop.abort();
      }),
    ),
  );
  if (failure) throw failure.cause;
}
