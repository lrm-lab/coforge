import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { getCoforgeAgentDir, getCoforgeSessionDir } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { ModelProviderSettingError, type CodeAgentProvider } from "@lrm/coforge-anvil";
import { createPiAgentSession } from "@lrm/coforge-anvil/pi";
import { evalMemoryOfferOnly } from "#src/code-agent/agent-instructions";
import { piRuntimeHost } from "./host";

/** CoForge Agent uses the same Pi SDK implementation without a child process. */
export class CoforgeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.COFORGE;

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const runtime = options.runtime;
    if (runtime?.providerConfig?.kind !== "coforge")
      throw new ModelProviderSettingError("CoForge runtime provider config is required");
    if (!runtime.providerConfig.apiKey)
      throw new ModelProviderSettingError("CoForge runtime provider API key is required");
    if (runtime.providerConfig.providerId !== runtime.modelProvider)
      throw new ModelProviderSettingError("Pi runtime provider does not match the selected model");

    const environment = piRuntimeHost.buildSessionEnvironment(options);
    // In-process tools read the process env. A child Agent process would inherit
    // these from `environment`; this provider shares the Daemon process.
    if (environment.COFORGE_AGENT_PROXY_URL)
      Bun.env.COFORGE_AGENT_PROXY_URL = environment.COFORGE_AGENT_PROXY_URL;
    if (environment.COFORGE_AGENT_CONTEXT)
      Bun.env.COFORGE_AGENT_CONTEXT = environment.COFORGE_AGENT_CONTEXT;
    return createPiAgentSession(
      {
        cwd: options.agentWorkspaceDirectory,
        agentId: options.agentId,
        agentDir: getCoforgeAgentDir(options.agentWorkspaceDirectory),
        sessionDir: getCoforgeSessionDir(options.agentWorkspaceDirectory),
        sessionId: options.sessionId,
        sessionMode: options.sessionMode,
        modelProvider: runtime.modelProvider,
        model: runtime.model,
        reasoning: runtime.reasoning,
        apiKey: runtime.providerConfig.apiKey,
        instructions: options.instructions,
        environment,
        toolProfile: runtime.toolProfile,
        conversation: options.conversation,
        memoryControlSession: options.memoryControlSession,
        memoryOfferOnly: evalMemoryOfferOnly(),
      },
      async (...args) => options.onSessionId?.(...args),
      piRuntimeHost,
    );
  }
}
