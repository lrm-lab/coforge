import { encodeAgentServerFeatures, type AgentServerFeatures } from "@lrm/coforge-sdk/internal";
import { errorType } from "#src/server/errors/error-type.server";

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

  /** The snapshot one Computer's daemon missed while it was away, resent on its ready. The
   * resend is best-effort: a failed publish warns with the snapshot's revision and resolves,
   * because the next flag change or ready republishes anyway and a ready must not be held
   * hostage by it. */
  async publishComputer(workspaceId: string, computerId: string): Promise<void> {
    const run = this.#publishing.then(() => this.#publishComputer(workspaceId, computerId));
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
      await this.#publishPlacements(placements);
    }
  }

  async #publishComputer(workspaceId: string, computerId: string): Promise<void> {
    const rows = await this.dependencies.db.agent.findMany({
      where: { workspaceId, computerId, deletedAt: null },
      select: { id: true, workspaceId: true, computerId: true },
    });
    const sync = await this.#snapshotFor(
      rows.flatMap((row) =>
        row.computerId
          ? [{ workspaceId: row.workspaceId, computerId: row.computerId, agentId: row.id }]
          : [],
      ),
    );
    if (!sync) return;
    try {
      await this.#publish(sync);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_server_features:republish_failed",
          workspace_id: sync.workspaceId,
          computer_id: sync.computerId,
          revision: sync.revision,
          error_type: errorType(error),
        }),
      );
    }
  }

  async #snapshotFor(placements: Placement[]): Promise<AgentServerFeatures | null> {
    if (placements.length === 0) return null;
    const head = placements[0]!;
    if (!(await this.dependencies.supports(head.workspaceId, head.computerId))) return null;
    const enabled = await this.dependencies.enabled(head.workspaceId);
    return {
      protocolMajor: 1,
      requestId: `flag_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId: head.workspaceId,
      computerId: head.computerId,
      revision: ++revision,
      agentIds: placements.map((placement) => placement.agentId),
      agentContextView: enabled,
    };
  }

  async #publishPlacements(placements: Placement[]): Promise<void> {
    const sync = await this.#snapshotFor(placements);
    if (sync) await this.#publish(sync);
  }

  async #publish(sync: AgentServerFeatures): Promise<void> {
    await this.dependencies.publish(
      sync.workspaceId,
      sync.computerId,
      encodeAgentServerFeatures(sync),
    );
  }
}
