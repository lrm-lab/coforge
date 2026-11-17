import { decodeLocalMemoryCommand, type LocalMemoryCommand } from "@lrm/coforge-sdk/agent";
import {
  sameAgentMemoryScope,
  type AgentMemoryRequest,
  type AgentMemoryResult,
} from "@lrm/coforge-sdk/internal";

type Viewer = { workspaceId: string; userId: string };
type Assignment = { computerId: string; revision: string };
export type PendingAgentMemory = { request: AgentMemoryRequest; userId: string; revision: string };
export type AgentMemoryResults = {
  begin(pending: PendingAgentMemory): Promise<void>;
  read(requestId: string): Promise<AgentMemoryResult | undefined>;
  clear(requestId: string): Promise<void>;
};
export class AgentMemoryManagement {
  constructor(
    private readonly ports: {
      findOwned(viewer: Viewer, agentId: string): Promise<Assignment | undefined>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      supported(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      publish(request: AgentMemoryRequest): Promise<void>;
      results: AgentMemoryResults;
    },
  ) {}
  async execute(viewer: Viewer, agentId: string, input: LocalMemoryCommand) {
    const command = decodeLocalMemoryCommand(input);
    const assignment = await this.ports.findOwned(viewer, agentId);
    if (!assignment) return { status: "forbidden" as const };
    const computer = { workspaceId: viewer.workspaceId, computerId: assignment.computerId };
    if (!(await this.ports.online(computer))) return { status: "offline" as const };
    if (!(await this.ports.supported(computer))) return { status: "unsupported" as const };
    const request = { ...computer, requestId: crypto.randomUUID(), agentId, command };
    await this.ports.results.begin({
      request,
      userId: viewer.userId,
      revision: assignment.revision,
    });
    try {
      await this.ports.publish(request);
      const deadline = Date.now() + 5000;
      let attempts = 0;
      while (Date.now() < deadline) {
        const result = await this.ports.results.read(request.requestId);
        if (result && sameAgentMemoryScope(request, result)) {
          const current = await this.ports.findOwned(viewer, agentId);
          if (
            !current ||
            current.computerId !== assignment.computerId ||
            current.revision !== assignment.revision
          )
            return { status: "forbidden" as const };
          return { status: "ready" as const, result };
        }
        await Bun.sleep(attempts++ < 25 ? 20 : 100);
      }
      return { status: "timeout" as const };
    } finally {
      await this.ports.results.clear(request.requestId);
    }
  }
}
