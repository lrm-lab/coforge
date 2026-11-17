import {
  decodeDaemonRuntimeConfigureRequest,
  encodeDaemonRuntimeConfigureResponse,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import {
  isComputerApiKey,
  isLegacyDaemonApiKey,
  type DaemonCredentialStore,
} from "#src/credentials/credential-store";
import type { DaemonConfigStore } from "#src/persistence/daemon-config";
import { WorkspaceLifecycleSupersededError } from "#src/supervisor/lifecycle-superseded-error";
import type { DaemonStarted } from "#src/daemon-host/launcher";

export async function handleLocalRpcConfigure(
  payload: Uint8Array,
  input: {
    serverUrl: string;
    assertOwnServer: (expectedServerUrl: string, what: string) => void;
    validateCredential: (credential: string) => boolean | Promise<boolean>;
    runtime: {
      configure?(
        connection: DaemonConfig,
        options?: { loginSetup?: boolean },
      ): Promise<void | DaemonStarted>;
    };
    credentials: DaemonCredentialStore;
    configStore?: Pick<DaemonConfigStore, "load" | "save" | "clear">;
  },
): Promise<Uint8Array> {
  const request = decodeDaemonRuntimeConfigureRequest(payload);
  input.assertOwnServer(request.expectedServerUrl, "request");
  if (request.serverHttpUrl) input.assertOwnServer(request.serverHttpUrl, "configuration");
  const valid =
    request.protocolMajor === 1 &&
    [request.workspaceId, request.computerId, request.workspaceRoot, request.daemonApiKey].every(
      Boolean,
    ) &&
    (await input.validateCredential(request.daemonApiKey));
  const adopted = valid
    ? await adoptConfiguration(input, request, { loginSetup: request.loginSetup })
    : undefined;
  return encodeDaemonRuntimeConfigureResponse({
    protocolMajor: 1,
    requestId: request.requestId,
    accepted: valid,
    ...(adopted?.lifecycleUnderWay ? { lifecycleUnderWay: true } : {}),
  });
}

/**
 * Saves the credential and connection, rolling both back if the runtime refuses them. A configure
 * a later stop or setup superseded is not refused: the cloud already registered this key (and
 * revoked the one before it), so it stays. A rollback also restores only what this attempt
 * wrote, never a key a newer setup saved since.
 */
async function adoptConfiguration(
  input: {
    serverUrl: string;
    runtime: {
      configure?(
        connection: DaemonConfig,
        options?: { loginSetup?: boolean },
      ): Promise<void | DaemonStarted>;
    };
    credentials: DaemonCredentialStore;
    configStore?: Pick<DaemonConfigStore, "load" | "save" | "clear">;
  },
  request: {
    workspaceId: string;
    computerId: string;
    workspaceRoot: string;
    daemonApiKey: string;
  },
  options?: { loginSetup?: boolean },
): Promise<void | DaemonStarted> {
  const { runtime, credentials, configStore } = input;
  const { workspaceId, computerId } = request;
  const saved = await credentials.load(workspaceId, computerId);
  const previousConfig = await configStore?.load();
  // A `dk_` never displaces a stored `sk_computer`: the attach env's key can already be
  // revoked by a concurrent confirm-key, and persisting it parks the Workspace on
  // credential_revoked for good (task #572). An `sk_computer` request still replaces —
  // that is a rotation, not a stale attach.
  const credentialChanged =
    saved !== request.daemonApiKey &&
    !(saved !== null && isComputerApiKey(saved) && isLegacyDaemonApiKey(request.daemonApiKey));
  if (credentialChanged) await credentials.save(workspaceId, computerId, request.daemonApiKey);
  const connection = {
    workspaceId,
    computerId,
    workspaceRoot: request.workspaceRoot,
    serverHttpUrl: input.serverUrl,
  };
  try {
    if (!runtime.configure) throw new Error("daemon configuration is unavailable");
    const configured = await runtime.configure(connection, options);
    await configStore?.save(connection);
    return configured;
  } catch (error) {
    if (error instanceof WorkspaceLifecycleSupersededError) throw error;
    if (
      credentialChanged &&
      (await credentials.load(workspaceId, computerId)) === request.daemonApiKey
    ) {
      if (saved !== null) await credentials.save(workspaceId, computerId, saved);
      else await credentials.delete(workspaceId, computerId);
    }
    // Preserve the previous active config, if any. Never remove local state on failure.
    if (configStore) {
      if (previousConfig) await configStore.save(previousConfig);
      else await configStore.clear();
    }
    throw error;
  }
}
