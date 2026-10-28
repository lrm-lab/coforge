import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { CodeAgentProvider } from "#src/contract";
import { DevinSession } from "./session";
import type { DevinProviderOptions } from "./host";
import { assertDevinVersionSupported } from "./version";

export class DevinProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.DEVIN;
  constructor(private readonly options: DevinProviderOptions) {}
  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid Devin session ID");
    const command = this.options.command ?? [RUNTIME_PROVIDER.DEVIN];
    await assertDevinVersionSupported(command, this.options.host.versionReader);
    const session = new DevinSession(command, options, this.options);
    await session.open();
    return session;
  }
}
