import type { CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";
import { DshConnection, DSH_ACP_TIMEOUT_MS, dshBounded } from "./connection";
import { dshCatalogFromConfig } from "./catalog";
import { assertDshVersion } from "./version";
import type { DshRuntimeHost } from "./host";

/** Native exchange only: the host owns cwd, profile/account selection and per-version caching. */
export async function discoverDshCatalog(options: {
  command: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  host: DshRuntimeHost;
  timeoutMs?: number;
}): Promise<CodeAgentModelCatalog> {
  await assertDshVersion(options.command, options.host.versionReader);
  const files = await options.host.prepareLaunch("");
  const bounded = <T>(work: Promise<T>) =>
    dshBounded(work, options.timeoutMs ?? DSH_ACP_TIMEOUT_MS);
  let transport: DshConnection | undefined;
  let sessionId: string | undefined;
  try {
    transport = new DshConnection(
      options.command,
      options.cwd,
      options.host.buildEnvironment({
        agentWorkspaceDirectory: options.cwd,
        instructions: "",
        environment: options.environment,
      }),
      options.host,
      files.patchPath,
    );
    const agent = transport.connection.agent;
    await transport.initialize(options.timeoutMs ?? DSH_ACP_TIMEOUT_MS);
    const state = await bounded(agent.request("session/new", { cwd: options.cwd, mcpServers: [] }));
    sessionId = state.sessionId;
    return dshCatalogFromConfig(state.configOptions ?? []);
  } finally {
    try {
      if (transport && sessionId)
        await bounded(transport.connection.agent.request("session/close", { sessionId }));
    } finally {
      try {
        await transport?.dispose();
      } finally {
        await files.cleanup();
      }
    }
  }
}
