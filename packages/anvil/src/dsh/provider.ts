import type { AgentSessionOptions, AgentSession } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { CodeAgentProvider } from "#src/contract";
import { DshSession } from "./session";
import { assertDshVersion } from "./version";
import type { DshProviderOptions } from "./host";

export class DshProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.DSH;
  constructor(private readonly options: DshProviderOptions) {}
  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const command = this.options.command ?? [RUNTIME_PROVIDER.DSH];
    await assertDshVersion(command, this.options.host.versionReader);
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid DSH session ID");
    const files = await this.options.host.prepareLaunch(options.instructions);
    let session: DshSession | undefined;
    try {
      session = new DshSession(command, options, this.options, files);
      await session.open();
      return session;
    } catch (error) {
      if (session) await session.dispose();
      else await files.cleanup();
      throw error;
    }
  }
}
