type TreeNode<T> = { task: T; children: readonly TreeNode<T>[] };

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
