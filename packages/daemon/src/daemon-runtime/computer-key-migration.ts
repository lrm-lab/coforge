import { getLogger } from "@logtape/logtape";
import type {
  DaemonCredentialConfirmations,
  DaemonCredentialStore,
} from "#src/credentials/credential-store";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** The shape the server mints (`daemon-api-key.server.ts`): prefix plus 43-token body. A swapped
 * key that fails this is proxy garbage — saving it would leave the daemon unable to connect. */
const COMPUTER_API_KEY = /^sk_computer_[A-Za-z0-9_-]{43}$/;

/**
 * The daemon key migration (task #417, step 2): a stored `dk_` swaps for an `sk_computer` — the
 * Computer's own credential — and a stored `sk_computer` confirms itself once. The new key is
 * written to the credential store BEFORE `confirm-key` retires the old one, so a failed save never
 * strands the daemon; an unconfirmed `sk_computer` is already valid. Answers the key the
 * connection should use: the migrated one on success, the stored one otherwise.
 *
 * Abort discipline: a stop or re-configure aborts `signal`; the migration then saves nothing and
 * confirms nothing — a confirm issued after a concurrent re-attach could revoke the new key. The
 * pre-save `load` covers a configure that rewrote the file while `swap-key` was in flight.
 */
export async function migrateComputerKey(ports: {
  credentials: Pick<DaemonCredentialStore, "load" | "save"> &
    Partial<DaemonCredentialConfirmations>;
  client: Pick<ComputerSelfClient, "swapKey" | "confirmKey"> | undefined;
  workspaceId: string;
  computerId: string;
  apiKey: string;
  signal: AbortSignal;
}): Promise<string> {
  const { credentials, client, workspaceId, computerId, apiKey, signal } = ports;
  const scope = { workspaceId, computerId };
  if (!client) return apiKey;
  if (apiKey.startsWith("sk_computer_")) {
    if (await credentials.isConfirmed?.(workspaceId, computerId, apiKey)) return apiKey;
    const confirm = await client.confirmKey(apiKey, signal);
    if (confirm.ok) {
      logger.info("daemon_key:confirm", scope);
      await markConfirmed(credentials, workspaceId, computerId, apiKey, scope);
    } else logger.warning("daemon_key:confirm_failed", { ...scope, detail: confirm.error.detail });
    return apiKey;
  }
  if (!apiKey.startsWith("dk_")) return apiKey;
  const swapped = await client.swapKey(apiKey, signal);
  if (!swapped.ok) {
    if (swapped.error.kind === "unsupported") logger.info("daemon_key:swap_unsupported", scope);
    else logger.warning("daemon_key:swap_failed", { ...scope, detail: swapped.error.detail });
    return apiKey;
  }
  if (!COMPUTER_API_KEY.test(swapped.value.apiKey)) {
    logger.warning("daemon_key:swap_invalid", scope);
    return apiKey;
  }
  if (signal.aborted) return apiKey;
  const stored = await credentials.load(workspaceId, computerId);
  if (stored !== apiKey) {
    logger.info("daemon_key:swap_superseded", scope);
    return stored ?? apiKey;
  }
  try {
    await credentials.save(workspaceId, computerId, swapped.value.apiKey);
  } catch (error) {
    logger.warning("daemon_key:save_failed", {
      ...scope,
      detail: error instanceof Error ? error.message : String(error),
    });
    return apiKey;
  }
  logger.info("daemon_key:swap", scope);
  if (signal.aborted) return swapped.value.apiKey;
  const confirm = await client.confirmKey(swapped.value.apiKey, signal);
  if (confirm.ok) {
    logger.info("daemon_key:confirm", scope);
    await markConfirmed(credentials, workspaceId, computerId, swapped.value.apiKey, scope);
  } else logger.warning("daemon_key:confirm_failed", { ...scope, detail: confirm.error.detail });
  return swapped.value.apiKey;
}

/** The confirmation marker is a hint, never a gate: a failed write only means the next start
 * confirms again. It must not fail the startup it serves. */
async function markConfirmed(
  credentials: Pick<Partial<DaemonCredentialConfirmations>, "markConfirmed">,
  workspaceId: string,
  computerId: string,
  apiKey: string,
  scope: Record<string, string>,
): Promise<void> {
  try {
    await credentials.markConfirmed?.(workspaceId, computerId, apiKey);
  } catch (error) {
    logger.warning("daemon_key:mark_failed", {
      ...scope,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
