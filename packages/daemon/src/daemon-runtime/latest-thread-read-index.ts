export type LatestThreadRead = { target: string; order: number };

type ReadEntry = { readOrder?: number; reviewedSeq?: number };

export class LatestThreadReadIndex {
  readonly #byAgent = new Map<string, Map<string, LatestThreadRead>>();

  clear(agentId: string): void {
    this.#byAgent.delete(agentId);
  }

  record(agentId: string, target: string, entry: ReadEntry): void {
    const index = this.#byAgent.get(agentId);
    if (index) this.#indexThreadRead(index, target, entry);
  }

  get(
    agentId: string,
    parentTarget: string,
    targets: ReadonlyMap<string, ReadEntry>,
  ): LatestThreadRead | undefined {
    const existing = this.#byAgent.get(agentId);
    if (existing) return existing.get(parentTarget);
    const index = new Map<string, LatestThreadRead>();
    this.#byAgent.set(agentId, index);
    for (const [target, entry] of targets) this.#indexThreadRead(index, target, entry);
    return index.get(parentTarget);
  }

  #indexThreadRead(index: Map<string, LatestThreadRead>, target: string, entry: ReadEntry): void {
    if (entry.readOrder === undefined || (entry.reviewedSeq ?? 0) < 1) return;
    for (let separator = target.indexOf(":"); separator > 0;) {
      const parent = target.slice(0, separator);
      const previous = index.get(parent);
      if (!previous || previous.order < entry.readOrder)
        index.set(parent, { target, order: entry.readOrder });
      separator = target.indexOf(":", separator + 1);
    }
  }
}
