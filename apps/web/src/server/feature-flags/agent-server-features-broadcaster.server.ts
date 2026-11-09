import { encodeAgentServerFeatures, type AgentServerFeatures } from "@lrm/coforge-sdk/internal";

type Placement = { workspaceId: string; computerId: string; agentId: string };
type Dependencies = {
  db: {
    agent: {
      findMany(
        args: unknown,
      ): Promise<Array<{ id: string; workspaceId: string; computerId: string | null }>>;
    };
  };
  supports(workspaceId: string, computerId: string): Promise<boolean>;
  enabled(workspaceId: string): Promise<boolean>;
  publish(workspaceId: string, computerId: string, payload: Uint8Array): Promise<void>;
};

let revision = 0;

export class AgentServerFeaturesBroadcaster {
  #publishing = Promise.resolve();

  constructor(private readonly dependencies: Dependencies) {}

  async publishSnapshot(): Promise<void> {
    const run = this.#publishing.then(() => this.#publishSnapshot());
    this.#publishing = run.catch(() => {});
    return run;
  }

  async #publishSnapshot(): Promise<void> {
    const rows = await this.dependencies.db.agent.findMany({
      where: { deletedAt: null, computerId: { not: null } },
      select: { id: true, workspaceId: true, computerId: true },
    });
    const grouped = new Map<string, Placement[]>();
    for (const row of rows) {
      if (!row.computerId) continue;
      const key = `${row.workspaceId}\0${row.computerId}`;
      const current = grouped.get(key) ?? [];
      current.push({ workspaceId: row.workspaceId, computerId: row.computerId, agentId: row.id });
      grouped.set(key, current);
    }
    for (const placements of grouped.values()) {
      if (
        !(await this.dependencies.supports(placements[0]!.workspaceId, placements[0]!.computerId))
      )
        continue;
      const enabled = await this.dependencies.enabled(placements[0]!.workspaceId);
      const sync: AgentServerFeatures = {
        protocolMajor: 1,
        requestId: `flag_${crypto.randomUUID().replaceAll("-", "")}`,
        workspaceId: placements[0]!.workspaceId,
        computerId: placements[0]!.computerId,
        revision: ++revision,
        agentIds: placements.map((placement) => placement.agentId),
        agentContextView: enabled,
      };
      await this.dependencies.publish(
        sync.workspaceId,
        sync.computerId,
        encodeAgentServerFeatures(sync),
      );
    }
  }
}
