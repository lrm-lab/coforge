import type {
  AgentContextQueryResponse,
  AgentContextReadRequest,
  AgentContextSearchRequest,
  AgentVersionResponse,
} from "@lrm/coforge-sdk/agent";
import { COFORGE_DAEMON_VERSION } from "../version";

import type { ComputerUpdateNotice } from "./computer-update-notice";
import { AgentContextRuntime } from "#src/daemon-runtime/agent-context-runtime";
import type { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { resolveContextViewProviderSource } from "./context-view-runtime-wiring";

type RuntimeLocalQueryHost = {
  authorizedAgent(context: string, agentApiKey: string | undefined): string;
  service: Pick<AgentContextViewService, "find">;
  enabled: Map<string, boolean>;
  workspaceRoot: string;
  stateDirectory: string;
  runtime(
    agentId: string,
  ):
    | { config: { provider: string; envVars?: Record<string, string> }; session?: unknown }
    | undefined;
  restartConfig(agentId: string): { config: { envVars?: Record<string, string> } } | undefined;
  reported(agentId: string): { launchId?: string; sessionId?: string } | undefined;
  currentActivityLaunch(agentId: string): { launchId?: string } | undefined;
  stopping(agentId: string): boolean;
  agentProcessManager: Pick<AgentProcessManager, "session">;
};

/**
 * `coforge version`'s local-only answer, assembled entirely from this already-running
 * Workspace child, never forwarded to Web/backend. `computerVersion` is the Computer executable
 * version this Daemon was launched with (`runDaemon(args, computerVersion)`, `packages/computer/
 * src/main.ts`'s `__workspace-daemon` dispatch); it bundles both the Computer and Daemon package
 * roles into one executable, so this is not a second installation.
 */
export function localVersionResponse(own: {
  computerVersion?: string;
  startedAt: number;
}): AgentVersionResponse {
  return {
    ok: true,
    daemonVersion: COFORGE_DAEMON_VERSION,
    ...(own.computerVersion ? { computerVersion: own.computerVersion } : {}),
    daemonPid: process.pid,
    startedAt: own.startedAt,
  };
}

/** The one-line "a newer Computer release exists" notice a CLI appends to its output — local
 * only, once per calendar day per computer; null when nothing is newer or already told. */
export async function localComputerUpdateNotice(
  notice: ComputerUpdateNotice,
): Promise<{ ok: true; notice: string | null }> {
  // A failed read/write answers "no notice", never an error: the line is best effort.
  return { ok: true, notice: await notice.takeNotice().catch(() => null) };
}

export async function queryLocalVersion(input: {
  authorize(context: string, agentApiKey: string): void;
  context: string;
  agentApiKey: string;
  computerVersion?: string;
  startedAt: number;
}): Promise<AgentVersionResponse> {
  input.authorize(input.context, input.agentApiKey);
  return localVersionResponse({
    computerVersion: input.computerVersion,
    startedAt: input.startedAt,
  });
}

export async function queryLocalComputerUpdateNotice(input: {
  authorize(context: string, agentApiKey: string): void;
  context: string;
  agentApiKey: string;
  notice: ComputerUpdateNotice;
}): Promise<{ ok: true; notice: string | null }> {
  input.authorize(input.context, input.agentApiKey);
  return localComputerUpdateNotice(input.notice);
}

export class RuntimeLocalQueries {
  readonly #context: AgentContextRuntime;
  readonly #authorize: (context: string, agentApiKey: string | undefined) => string;
  readonly #computerVersion: string | undefined;
  readonly #startedAt: number;
  readonly #notice: ComputerUpdateNotice;

  constructor(
    host: RuntimeLocalQueryHost,
    computerVersion: string | undefined,
    startedAt: number,
    notice: ComputerUpdateNotice,
  ) {
    this.#authorize = host.authorizedAgent.bind(host);
    this.#computerVersion = computerVersion;
    this.#startedAt = startedAt;
    this.#notice = notice;
    this.#context = new AgentContextRuntime({
      authorize: this.#authorize,
      workspaceRoot: host.workspaceRoot,
      stateDirectory: host.stateDirectory,
      contextView: host.service,
      resolveProviderSource: (agentId, entry) =>
        resolveContextViewProviderSource(host, agentId, entry),
      currentSessionId: (agentId) => {
        if (host.stopping(agentId) || !host.agentProcessManager.session(agentId)) return undefined;
        const reported = host.reported(agentId);
        const launch = host.currentActivityLaunch(agentId);
        return reported && reported.launchId === launch?.launchId ? reported.sessionId : undefined;
      },
      contextViewEnabled: host.enabled.get.bind(host.enabled),
    });
  }

  version(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentVersionResponse> {
    return queryLocalVersion({
      authorize: this.#authorize,
      context,
      agentApiKey,
      computerVersion: this.#computerVersion,
      startedAt: this.#startedAt,
    });
  }

  context(
    context: string,
    request: AgentContextSearchRequest | AgentContextReadRequest,
    agentApiKey: string,
  ): Promise<AgentContextQueryResponse> {
    return this.#context.run(context, request, agentApiKey);
  }

  computerUpdateNotice(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<{ ok: true; notice: string | null }> {
    return queryLocalComputerUpdateNotice({
      authorize: this.#authorize,
      context,
      agentApiKey,
      notice: this.#notice,
    });
  }
}
