import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { getCoforgeAgentDir, getCoforgeSessionDir } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { ModelProviderSettingError, type CodeAgentProvider } from "@lrm/coforge-anvil";
import { createPiAgentSession } from "@lrm/coforge-anvil/pi";
import { getLogger } from "@logtape/logtape";
import { piRuntimeHost } from "./host";
const logger = getLogger(["coforge", "daemon", "code-agent", "pi"]);
export class CoforgeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.COFORGE;
  readonly reportsCompaction = true;
  readonly compactionFailure = "sticks_to_session";
  readonly supportsSessionSummaryRecycle = true;
  readonly standingPromptRefreshesOnResume = true;
  constructor(private readonly options?: Readonly<{ agentDir?: string }>) {}
  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const runtime = options.runtime;
    if (!runtime) throw new ModelProviderSettingError("CoForge runtime config is required");
    const providerConfig =
      runtime.providerConfig?.kind === "coforge" ? runtime.providerConfig : undefined;
    if (!providerConfig)
      logger.info("code_agent:provider_config_defaulted", {
        provider: RUNTIME_PROVIDER.COFORGE,
        reason: runtime.providerConfig ? "default" : "missing",
      });
    if (providerConfig && !providerConfig.apiKey)
      throw new ModelProviderSettingError("CoForge runtime provider API key is required");
    if (providerConfig && providerConfig.providerId !== runtime.modelProvider)
      throw new ModelProviderSettingError("Pi runtime provider does not match the selected model");
    const environment = piRuntimeHost.buildSessionEnvironment(options);
    if (environment.COFORGE_AGENT_PROXY_URL)
      Bun.env.COFORGE_AGENT_PROXY_URL = environment.COFORGE_AGENT_PROXY_URL;
    if (environment.COFORGE_AGENT_CONTEXT)
      Bun.env.COFORGE_AGENT_CONTEXT = environment.COFORGE_AGENT_CONTEXT;
    return createPiAgentSession(
      {
        cwd: options.agentWorkspaceDirectory,
        agentId: options.agentId,
        agentDir: this.options?.agentDir ?? getCoforgeAgentDir(options.agentWorkspaceDirectory),
        sessionDir: getCoforgeSessionDir(options.agentWorkspaceDirectory),
        sessionId: options.sessionId,
        sessionMode: options.sessionMode,
        contextViewRequestLogDirectory: options.contextViewRequestLogDirectory,
        modelProvider: runtime.modelProvider,
        model: runtime.model,
        contextWindow: runtime.contextWindow,
        maxOutputTokens: runtime.maxOutputTokens,
        reasoning: runtime.reasoning,
        apiKey: providerConfig?.apiKey,
        instructions: options.instructions,
        environment,
        conversation: options.conversation,
      },
      async (...args) => options.onSessionId?.(...args),
      piRuntimeHost,
    );
  }
}
