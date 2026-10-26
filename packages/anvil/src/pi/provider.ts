import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { PI_SESSION_DIR } from "@coforge/agent";
import { join } from "node:path";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { ModelProviderSettingError, type CodeAgentProvider } from "#src/contract";
import type { PiProviderOptions, PiRuntimeHost } from "./host";
import { createPiAgentSession } from "./session";

export class PiProvider implements CodeAgentProvider {
  readonly provider: RuntimeProvider = RUNTIME_PROVIDER.PI;

  readonly #host: PiRuntimeHost;

  constructor(options: PiProviderOptions) {
    this.#host = options.host;
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const runtime = options.runtime;
    const credential =
      runtime?.providerConfig?.kind === "coforge" ? runtime.providerConfig : undefined;
    if (credential && credential.providerId !== runtime?.modelProvider)
      throw new ModelProviderSettingError("Pi runtime provider does not match the selected model");
    if (credential?.apiKey && !runtime?.modelProvider)
      throw new ModelProviderSettingError("Pi model provider is required for an Agent API key");
    const environment = this.#host.buildSessionEnvironment(options);
    const hostAgentDir = environment.PI_CODING_AGENT_DIR ?? this.#host.getDefaultAgentDirectory();
    return createPiAgentSession(
      {
        cwd: options.agentWorkspaceDirectory,
        agentDir: hostAgentDir,
        sessionDir: join(options.agentWorkspaceDirectory, PI_SESSION_DIR),
        sessionId: options.sessionId,
        sessionMode: options.sessionMode,
        modelProvider: runtime?.modelProvider,
        model: runtime?.model,
        reasoning: runtime?.reasoning,
        apiKey: credential?.apiKey,
        instructions: options.instructions,
        environment,
        sessionKind: "pi",
        toolProfile: runtime?.toolProfile,
        conversation: options.conversation,
        memoryControlSession: options.memoryControlSession,
      },
      async (...args) => options.onSessionId?.(...args),
      this.#host,
    );
  }
}
