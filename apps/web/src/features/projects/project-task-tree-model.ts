type TreeNode<T> = { task: T; children: readonly TreeNode<T>[] };

/** A Task under its parent, with its own sub-tasks under it. */
export type ForestNode<T> = { task: T; children: ForestNode<T>[] };

/**
 * Tasks as a forest: each under its parent when the parent is listed too, otherwise at the top
 * (its parent is finished, elsewhere or not the reader's). Order is the list's own. A parent
 * chain that loops back on itself has no top to hang from: each Task no top reaches is lifted to
 * the top, its link to its parent dropped, so a loop never hides a Task nor nests forever.
 */
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

/** A node of a Project's task tree under a filter: `matched` false for an ancestor kept only for
 * what passes below it. */
export type FilteredNode<T> = { task: T; matched: boolean; children: FilteredNode<T>[] };

/**
 * A Project's task tree as a filter leaves it (task #462): every Task that passes, under each of
 * its ancestors, which stay (marked as not passing) so a sub-task is never torn from where it
 * belongs. A node with nothing passing in it drops out.
 */
export function filterTaskForest<T>(
  nodes: readonly TreeNode<T>[],
  matches: (task: T) => boolean,
): FilteredNode<T>[] {
  return nodes.flatMap((node) => {
    const children = filterTaskForest(node.children, matches);
    const matched = matches(node.task);
    return matched || children.length > 0 ? [{ task: node.task, matched, children }] : [];
  });
}

/** The ids of every node with children: a tree opens with all of them unfolded. */
export function parentIds<T extends { id: string }>(nodes: readonly FilteredNode<T>[]): string[] {
  return nodes.flatMap((node) =>
    node.children.length > 0 ? [node.task.id, ...parentIds(node.children)] : [],
  );
}
