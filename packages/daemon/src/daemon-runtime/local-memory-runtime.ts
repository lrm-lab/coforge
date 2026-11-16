import type { LocalMemoryCommand, LocalMemoryResult } from "@lrm/coforge-sdk/agent";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { LocalMemory } from "#src/local-memory/local-memory";

export class LocalMemoryRuntime {
  readonly #stores = new Map<string, LocalMemory>();
  constructor(
    private readonly authorize: (context: string, key: string) => string,
    private readonly workspace: () => { workspaceRoot: string; workspaceId: string },
  ) {}

  execute(context: string, request: LocalMemoryCommand, key: string): Promise<LocalMemoryResult> {
    const agentId = this.authorize(context, key);
    const workspace = this.workspace();
    let memory = this.#stores.get(agentId);
    if (!memory) {
      memory = new LocalMemory(
        agentWorkspaceDirectory(workspace.workspaceRoot, workspace.workspaceId, agentId),
      );
      this.#stores.set(agentId, memory);
    }
    return memory.execute(request);
  }
}
