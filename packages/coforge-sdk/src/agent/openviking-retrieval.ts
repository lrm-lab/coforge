/** Graph navigation vocabulary and the retrieval envelope an OpenViking read returns. */

export const OPENVIKING_GRAPH_RELATIONS = [
  "incoming",
  "outgoing",
  "source",
  "target",
  "forks",
  "anchor",
  "branch_steps",
  "next",
  "previous",
  "observed_block",
] as const;
export type OpenVikingGraphRelation = (typeof OPENVIKING_GRAPH_RELATIONS)[number];

export type OpenVikingRetrieval = {
  mode: "bm25";
  chainRef: string;
  step: number;
  remainingHops: number;
  exhausted: boolean;
  nodes: Array<{
    uri: string;
    kind: string;
    status?: string;
    sourceRef?: string;
    relations: OpenVikingGraphRelation[];
  }>;
};

export function decodeRetrieval(value: unknown): OpenVikingRetrieval | undefined {
  if (value === undefined) return undefined;
  const row = value as Partial<OpenVikingRetrieval> | null;
  if (
    !row ||
    row.mode !== "bm25" ||
    typeof row.chainRef !== "string" ||
    !row.chainRef.trim() ||
    row.chainRef.length > 256 ||
    !Number.isInteger(row.step) ||
    row.step! < 0 ||
    !Number.isInteger(row.remainingHops) ||
    row.remainingHops! < 0 ||
    typeof row.exhausted !== "boolean" ||
    !Array.isArray(row.nodes)
  )
    throw new Error("invalid BM25 retrieval navigation");
  const nodes = row.nodes.map((node) => {
    if (
      !node ||
      typeof node.uri !== "string" ||
      typeof node.kind !== "string" ||
      (node.status !== undefined && typeof node.status !== "string") ||
      (node.sourceRef !== undefined && typeof node.sourceRef !== "string") ||
      !Array.isArray(node.relations) ||
      node.relations.some(
        (relation) => !(OPENVIKING_GRAPH_RELATIONS as readonly unknown[]).includes(relation),
      )
    )
      throw new Error("invalid graph navigation node");
    return {
      uri: node.uri,
      kind: node.kind,
      ...(node.status === undefined ? {} : { status: node.status }),
      ...(node.sourceRef === undefined ? {} : { sourceRef: node.sourceRef }),
      relations: [...node.relations],
    };
  });
  return {
    mode: "bm25",
    chainRef: row.chainRef,
    step: row.step!,
    remainingHops: row.remainingHops!,
    exhausted: row.exhausted,
    nodes,
  };
}
