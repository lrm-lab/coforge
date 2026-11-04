import type { DaemonCredentialStore } from "#src/credentials/credential-store";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";
import type { ManagedBinding } from "./machine-supervisor";

/**
 * `daemon:detach` (task #417 step 3): the machine asks to leave a Workspace, server first —
 * the Workspace daemon keeps running until `POST /api/computer/detach` answers that the key is
 * revoked and the link gone. Only then does the local half follow: the Workspace child stops,
 * its binding leaves the store, and its credential is deleted. Every ambiguous answer — a
 * retryable failure, a timeout, a server that could not be asked because the credential is
 * missing — keeps the binding exactly as it was and reports `unconfirmed`.
 */
export async function detachManagedBinding({
  workspaceId,
  bindings,
  stop,
  store,
  credentials,
  makeSelfClient,
  /** For a Workspace the supervisor has no binding for (task #417): the Computer's own id and
   * server, carried on the request, so the credential's key can still be told to unlink. */
  target,
}: {
  workspaceId: string;
  bindings: ManagedBinding[];
  stop: (binding: ManagedBinding) => Promise<void>;
  store: (next: ManagedBinding[]) => Promise<void>;
  credentials: Pick<DaemonCredentialStore, "load" | "delete">;
  /** Builds the self-client on the binding's own server URL — injectable so a test drives
   * definite and ambiguous answers without a server. */
  makeSelfClient: (serverHttpUrl: string) => Pick<ComputerSelfClient, "detach">;
  target?: { computerId: string; serverHttpUrl: string };
}): Promise<
  | { detached: true; keyRevoked?: boolean }
  | { detached: false; reason: "unconfirmed" | "not_bound" }
> {
  const binding = bindings.find((entry) => entry.workspaceId === workspaceId);
  // Nothing to stop locally, but a credential the request's own Computer left here may still
  // be alive server-side — ask it the same way rather than answer detached on a live key.
  if (!binding) {
    if (!target) return { detached: false, reason: "not_bound" };
    const apiKey = await credentials.load(workspaceId, target.computerId);
    if (!apiKey) return { detached: false, reason: "not_bound" };
    const detached = await makeSelfClient(target.serverHttpUrl)
      .detach(apiKey, AbortSignal.timeout(30_000))
      .then((result) => (result.ok ? result.value : undefined))
      .catch(() => undefined);
    if (!detached) return { detached: false, reason: "unconfirmed" };
    await credentials.delete(workspaceId, target.computerId);
    return { detached: true, keyRevoked: detached === "key_revoked" };
  }
  // A server confirmation an earlier attempt recorded finishes locally without asking the
  // server again — the key it revoked is gone either way, so the local half retries on its
  // own (task #417).
  const confirmed = binding.detachConfirmed === true;
  let keyRevoked = binding.detachKeyRevoked === true;
  if (!confirmed) {
    const apiKey = await credentials.load(workspaceId, binding.computerId);
    const answer =
      apiKey && binding.serverHttpUrl
        ? await makeSelfClient(binding.serverHttpUrl)
            .detach(apiKey, AbortSignal.timeout(30_000))
            .then((result) => (result.ok ? result.value : undefined))
            .catch(() => undefined)
        : undefined;
    if (!answer) return { detached: false, reason: "unconfirmed" };
    keyRevoked = answer === "key_revoked";
    // Persist the confirmation before the local half runs — and how the server answered, so a
    // retry after a failed local stop reports a revoked key the same way it does a plain one.
    await store(
      bindings.map((entry) =>
        entry === binding
          ? { ...entry, detachConfirmed: true, detachKeyRevoked: keyRevoked || undefined }
          : entry,
      ),
    );
  }
  await stop(binding);
  const next = bindings.filter((entry) => entry.workspaceId !== workspaceId);
  await store(next);
  await credentials.delete(workspaceId, binding.computerId);
  return { detached: true, ...(keyRevoked ? { keyRevoked: true } : {}) };
}
