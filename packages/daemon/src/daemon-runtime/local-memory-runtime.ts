import type { LocalMemoryCommand, LocalMemoryResult } from "@lrm/coforge-sdk/agent";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { LocalMemory } from "#src/local-memory/local-memory";

export class LocalMemoryRuntime {
  readonly #stores = new Map<string, { memory: LocalMemory; active: number }>();
  constructor(
    private readonly authorize: (context: string, key: string) => string,
    private readonly workspace: () => { workspaceRoot: string; workspaceId: string },
  ) {}

  execute(context: string, request: LocalMemoryCommand, key: string): Promise<LocalMemoryResult> {
    const agentId = this.authorize(context, key);
    const workspace = this.workspace();
    let store = this.#stores.get(agentId);
    if (!store) {
      store = {
        memory: new LocalMemory(
          agentWorkspaceDirectory(workspace.workspaceRoot, workspace.workspaceId, agentId),
        ),
        active: 0,
      };
    }
    this.#stores.delete(agentId);
    this.#stores.set(agentId, store);
    store.active++;
    return store.memory.execute(request).finally(() => {
      store.active--;
      for (const [id, candidate] of this.#stores) {
        if (this.#stores.size <= 32) break;
        if (candidate.active === 0) this.#stores.delete(id);
      }
    });
  }
}
