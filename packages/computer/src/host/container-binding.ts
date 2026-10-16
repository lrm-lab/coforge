import {
  FileBindingStore,
  FileDaemonCredentialStore,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";

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

const REQUIRED_ENV = [
  "COFORGE_DAEMON_API_KEY",
  "COFORGE_WORKSPACE_ID",
  "COFORGE_COMPUTER_ID",
  "COFORGE_SERVER_URL",
] as const;

const PRESENT_ENV = [...REQUIRED_ENV, "COFORGE_WORKSPACE_SLUG", "COFORGE_COMPUTER_NAME"] as const;

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
): Promise<boolean> {
  const present = PRESENT_ENV.some((key) => text(env[key]) !== undefined);
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
  await new FileDaemonCredentialStore(workspaceStateDirectory(stateDirectory, workspaceId)).save(
    workspaceId,
    computerId,
    daemonApiKey,
  );
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
  const daemonApiKey = text(env.COFORGE_DAEMON_API_KEY);
  const serverHttpUrl = text(env.COFORGE_SERVER_URL)?.replace(/\/+$/, "");
  if (!workspaceId || !computerId || !daemonApiKey || !serverHttpUrl) return false;
  await startWorkspace({
    workspaceId,
    computerId,
    workspaceRoot: CONTAINER_WORKSPACE_ROOT,
    daemonApiKey,
    serverHttpUrl,
  });
  return true;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
