import {
  AgentMigrationRemoteError,
  type AgentMigrationBucket,
  type AgentMigrationSignedUrl,
} from "#src/agent-migration/transfer-ports";

/**
 * The migration bucket over HTTPS, by the presigned URLs the server signs per chunk. Statuses the
 * reference Computer retries (408, 425, 429, 5xx, and 404 on a download, for a chunk not yet
 * visible) are transient; any other refusal, 403 included, is final, because every attempt carries
 * a freshly signed URL. A caller's abort propagates as the abort.
 */
export class AgentMigrationBucketClient implements AgentMigrationBucket {
  async put(signed: AgentMigrationSignedUrl, bytes: Uint8Array, signal: AbortSignal) {
    const response = await request(signal, () =>
      fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes, signal }),
    );
    await response.body?.cancel();
    // 409: the bucket refused to overwrite the chunk, so it already holds it.
    if (response.ok || response.status === 409) return;
    throw refusal(response.status, false);
  }

  async get(url: string, sizeBytes: number, signal: AbortSignal) {
    const response = await request(signal, () => fetch(url, { signal }));
    if (!response.ok) {
      await response.body?.cancel();
      throw refusal(response.status, true);
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== sizeBytes) {
      await response.body?.cancel();
      throw new AgentMigrationRemoteError("size_mismatch", false, `${length} != ${sizeBytes}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== sizeBytes)
      throw new AgentMigrationRemoteError(
        "size_mismatch",
        false,
        `${bytes.byteLength} != ${sizeBytes}`,
      );
    return bytes;
  }
}

async function request(signal: AbortSignal, send: () => Promise<Response>) {
  try {
    return await send();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AgentMigrationRemoteError("network", true, (error as Error).message);
  }
}

function refusal(status: number, download: boolean) {
  const transient =
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    (download && status === 404);
  return new AgentMigrationRemoteError(
    transient ? "bucket_unavailable" : "bucket_refused",
    transient,
    String(status),
  );
}
