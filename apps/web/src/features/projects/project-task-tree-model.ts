export type ForestNode<T> = { task: T; children: ForestNode<T>[] };

export function taskForest<T extends { id: string; parentTaskId: string | null }>(
  tasks: readonly T[],
): ForestNode<T>[] {
  const nodes = new Map(tasks.map((task) => [task.id, { task, children: [] } as ForestNode<T>]));
  const roots: ForestNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.task.parentTaskId ? nodes.get(node.task.parentTaskId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const reached = new Set<ForestNode<T>>();
  const reach = (node: ForestNode<T>) => {
    if (reached.has(node)) return;
    reached.add(node);
    node.children.forEach(reach);
  };
  roots.forEach(reach);
  for (const node of nodes.values()) {
    if (reached.has(node)) continue;
    const parent = nodes.get(node.task.parentTaskId!)!;
    parent.children.splice(parent.children.indexOf(node), 1);
    roots.push(node);
    reach(node);
  }
  return roots;
}
