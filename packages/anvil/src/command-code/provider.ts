import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { CodeAgentProvider } from "#src/contract";
import { CommandCodeSession } from "./session";
import type { CommandCodeProviderOptions } from "./host";
import { assertCommandCodeVersionSupported } from "./version";
export class CommandCodeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.COMMAND_CODE;
  constructor(private readonly options: CommandCodeProviderOptions) {}
  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid Command Code session ID");
    const command = this.options.command ?? ["cmd"];
    await assertCommandCodeVersionSupported(command, this.options.host.versionReader);
    const session = new CommandCodeSession(command, options, this.options);
    await session.open();
    return session;
  }
}
