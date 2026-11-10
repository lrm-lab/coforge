import type {
  AgentContextQueryResponse,
  AgentContextReadRequest,
  AgentContextSearchRequest,
} from "@lrm/coforge-sdk/agent";
import type { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import type { ContextViewIndexEntry } from "#src/agent-context-view/context-view-store";
import { ContextViewRestoreCache } from "#src/agent-context-view/context-view-restore-cache";
import { queryAgentContext } from "./agent-context-query";

export function currentAgentContextSession(input: {
  reportedSessions: ReadonlyMap<string, Readonly<{ launchId: string; sessionId: string }>>;
  currentActivityLaunches: ReadonlyMap<string, Readonly<{ launchId: string }>>;
  isStopping(agentId: string): boolean;
  hasSession(agentId: string): boolean;
}): (agentId: string) => string | undefined {
  return (agentId) => {
    const reported = input.reportedSessions.get(agentId);
    const launch = input.currentActivityLaunches.get(agentId);
    if (
      !reported ||
      !launch ||
      reported.launchId !== launch.launchId ||
      input.isStopping(agentId) ||
      !input.hasSession(agentId)
    )
      return undefined;
    return reported.sessionId;
  };
}

export type AgentContextRuntimePorts = Readonly<{
  authorize(context: string, agentApiKey: string): string;
  workspaceRoot: string;
  stateDirectory: string;
  contextView: Pick<AgentContextViewService, "find">;
  resolveProviderSource?(agentId: string, entry: ContextViewIndexEntry): string | undefined;
  currentSessionId(agentId: string): string | undefined;
  contextViewEnabled?(agentId: string): boolean | undefined;
  restoreCache?: ContextViewRestoreCache;
}>;

export class AgentContextRuntime {
  readonly #restoreCache = new ContextViewRestoreCache();
  constructor(private readonly ports: AgentContextRuntimePorts) {}

  run(
    context: string,
    request: AgentContextSearchRequest | AgentContextReadRequest,
    agentApiKey: string,
  ): Promise<AgentContextQueryResponse> {
    return runAgentContextQuery({
      context,
      request,
      agentApiKey,
      authorize: this.ports.authorize,
      workspaceRoot: this.ports.workspaceRoot,
      stateDirectory: this.ports.stateDirectory,
      contextView: this.ports.contextView,
      resolveProviderSource: this.ports.resolveProviderSource,
      currentSessionId: this.ports.currentSessionId,
      contextViewEnabled: this.ports.contextViewEnabled,
      restoreCache: this.#restoreCache,
    });
  }
}

export async function runAgentContextQuery(input: {
  context: string;
  request: AgentContextSearchRequest | AgentContextReadRequest;
  agentApiKey: string;
  authorize(context: string, agentApiKey: string): string;
  workspaceRoot: string;
  stateDirectory: string;
  contextView: Pick<AgentContextViewService, "find">;
  resolveProviderSource?(agentId: string, entry: ContextViewIndexEntry): string | undefined;
  currentSessionId(agentId: string): string | undefined;
  contextViewEnabled?(agentId: string): boolean | undefined;
  restoreCache?: ContextViewRestoreCache;
}): Promise<AgentContextQueryResponse> {
  const agentId = input.authorize(input.context, input.agentApiKey);
  return queryAgentContext(
    {
      workspaceRoot: input.workspaceRoot,
      stateDirectory: input.stateDirectory,
      contextView: input.contextView,
      resolveProviderSource: input.resolveProviderSource,
      currentSessionId: input.currentSessionId,
      contextViewEnabled: input.contextViewEnabled,
      restoreCache: input.restoreCache,
    },
    agentId,
    input.request,
  );
}
