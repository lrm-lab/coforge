import type { TeamMemoryDecisionGraph } from "#src/server/db/repositories/team-memory-decision-graph.server";

type Point = readonly [x: number, y: number];
const center: Point = [0.47, 0.51];
const memorySlots = [
  [0.29, 0.27],
  [0.7, 0.26],
  [0.65, 0.77],
  [0.23, 0.76],
] as const;
const evidenceSlots = [
  [0.13, 0.47],
  [0.13, 0.1],
  [0.86, 0.12],
  [0.87, 0.61],
  [0.47, 0.1],
  [0.88, 0.87],
  [0.42, 0.89],
] as const;

export function memoryGraphLayout(graph: TeamMemoryDecisionGraph) {
  const positions = new Map<string, Point>([[graph.root, center]]);
  const available: Point[] = [...memorySlots];
  for (const node of graph.nodes) {
    if (node.type !== "memory" || node.key === graph.root) continue;
    const connects = graph.edges.filter(
      (edge) =>
        (edge.from === graph.root && edge.to === node.key) ||
        (edge.to === graph.root && edge.from === node.key),
    );
    const direction = connects.find(
      (edge) => edge.kind === "supersedes" || edge.kind === "revision",
    );
    const preferred = direction ? memorySlots[direction.to === graph.root ? 0 : 1] : memorySlots[2];
    const index = Math.max(0, available.indexOf(preferred));
    const [point] = available.splice(index, 1);
    if (point) positions.set(node.key, point);
  }
  const free: Point[] = [...evidenceSlots];
  for (const node of graph.nodes) {
    if (node.type !== "evidence") continue;
    const support = graph.edges.find((edge) => edge.kind === "supports" && edge.from === node.key);
    const origin = (support && positions.get(support.to)) ?? center;
    free.sort(
      ([ax, ay], [bx, by]) =>
        Math.hypot(ax - origin[0], ay - origin[1]) - Math.hypot(bx - origin[0], by - origin[1]),
    );
    const point = free.shift();
    if (point) positions.set(node.key, point);
  }
  return positions;
}

export function memoryGraphLine(
  from: Point,
  to: Point,
  width: number,
  height: number,
  start: number,
  end: number,
) {
  const dx = (to[0] - from[0]) * width;
  const dy = (to[1] - from[1]) * height;
  const length = Math.hypot(dx, dy);
  if (length <= start + end) return undefined;
  return {
    x1: from[0] * width + (dx * start) / length,
    y1: from[1] * height + (dy * start) / length,
    x2: to[0] * width - (dx * end) / length,
    y2: to[1] * height - (dy * end) / length,
  };
}
