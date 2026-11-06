import {
  FileBindingStore,
  FileDaemonCredentialStore,
  isComputerApiKey,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";
import { CONTAINER_BINDING_ENV_KEYS } from "./container-binding-env";

/** Agent workspaces live on the computer volume, so a replaced container can
 * resume the sessions already stored there. */
export const CONTAINER_WORKSPACE_ROOT = "/root/.coforge/agent-workspaces";

export type RunningWorkspaceStart = {
  workspaceId: string;
  computerId: string;
  workspaceRoot: string;
  daemonApiKey: string;
  serverHttpUrl: string;
};

/**
 * Write the Daemon credential and one enabled workspace binding, keeping any
 * other workspace already stored. A normal foreground start has none of these
 * variables and leaves the state directory untouched. The same workspace is
 * rewritten in place so a restarted task stays idempotent.
 */
export async function prepareContainerBinding(
  env: Record<string, string | undefined>,
  stateDirectory: string,
  expectedServerUrl?: string,
  options?: { seedOnly?: boolean },
): Promise<boolean> {
  const present = CONTAINER_BINDING_ENV_KEYS.some((key) => text(env[key]) !== undefined);
  if (!present) return false;
  const daemonApiKey = text(env.COFORGE_DAEMON_API_KEY);
  const workspaceId = text(env.COFORGE_WORKSPACE_ID);
  const computerId = text(env.COFORGE_COMPUTER_ID);
  const serverHttpUrl = text(env.COFORGE_SERVER_URL)?.replace(/\/+$/, "");
  if (!daemonApiKey || !workspaceId || !computerId || !serverHttpUrl)
    throw new Error("container environment is incomplete");
  let server: URL;
  try {
    server = new URL(serverHttpUrl);
  } catch {
    throw new Error("container environment is incomplete");
  }
  if (expectedServerUrl && server.origin !== new URL(expectedServerUrl).origin)
    throw new Error("Binding server does not match this daemon build");
  const bindings = new FileBindingStore(stateDirectory, expectedServerUrl);
  const existing = await bindings.load();
  const binding = {
    workspaceId,
    computerId,
    workspaceRoot: CONTAINER_WORKSPACE_ROOT,
    serverHttpUrl,
    enabled: true,
  };
  const next = existing.some((item) => item.workspaceId === workspaceId)
    ? existing.map((item) => (item.workspaceId === workspaceId ? binding : item))
    : [...existing, binding];
  await bindings.save(next);
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(stateDirectory, workspaceId),
  );
  // An `sk_computer` — confirmed or not — still authenticates and the child's migrateComputerKey
  // confirms it on the next connect, so no env `dk_` may replace it: the attach's key could
  // already be revoked by a concurrent confirm-key, and persisting it parks the Workspace on
  // credential_revoked for good (task #572). `seedOnly` is the foreground restart: its env `dk_`
  // is the create job's original key, dead since the first confirm, so it only fills an empty
  // store and never displaces a credential the binding already holds.
  const stored = await credentials.load(workspaceId, computerId);
  if (stored && (options?.seedOnly === true || isComputerApiKey(stored))) {
    console.log(
      `[attach-workspace] workspace ${workspaceId} already holds ${isComputerApiKey(stored) ? "an sk_computer" : "a credential"}; keeping it (ignored the env's dk_)`,
    );
  } else {
    await credentials.save(workspaceId, computerId, daemonApiKey);
  }
  return true;
}

/** Writes the new workspace beside the ones already stored, then asks the running
 * supervisor to start only that workspace. */
export async function attachRunningWorkspace(
  env: Record<string, string | undefined>,
  stateDirectory: string,
  expectedServerUrl: string | undefined,
  startWorkspace: (config: RunningWorkspaceStart) => Promise<void>,
): Promise<boolean> {
  const wrote = await prepareContainerBinding(env, stateDirectory, expectedServerUrl);
  if (!wrote) return false;
  const workspaceId = text(env.COFORGE_WORKSPACE_ID);
  const computerId = text(env.COFORGE_COMPUTER_ID);
  const envKey = text(env.COFORGE_DAEMON_API_KEY);
  const serverHttpUrl = text(env.COFORGE_SERVER_URL)?.replace(/\/+$/, "");
  if (!workspaceId || !computerId || !envKey || !serverHttpUrl) return false;
  // Configure must carry the credential the file actually holds: `prepareContainerBinding` may
  // have kept a confirmed `sk_computer` over the env's `dk_`, and the supervisor's configure
  // writes whatever key it is handed back over that file — an attach key confirm-key already
  // revoked would brick the binding (task #572).
  const stored = await new FileDaemonCredentialStore(
    workspaceStateDirectory(stateDirectory, workspaceId),
  ).load(workspaceId, computerId);
  await startWorkspace({
    workspaceId,
    computerId,
    workspaceRoot: CONTAINER_WORKSPACE_ROOT,
    daemonApiKey: stored ?? envKey,
    serverHttpUrl,
  });
  return true;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
