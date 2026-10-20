const MAX_LEVEL = 5;
type HeadingLevel = 1 | 2 | 3 | 4 | 5;
export type OutlineNode =
  | { id: number; kind: "heading"; level: HeadingLevel; text: string }
  | { id: number; kind: "body"; text: string };

export function parseOutline(markdown: string): OutlineNode[] {
  if (!markdown) return [];
  const lines = markdown.endsWith("\n") ? markdown.slice(0, -1).split("\n") : markdown.split("\n");
  return lines.map((line, id) => {
    const heading = line.match(/^(#{1,5})\s+(.+)$/);
    if (!heading) return { id, kind: "body", text: line };
    return {
      id,
      kind: "heading",
      level: Math.min(heading[1]!.length, MAX_LEVEL) as HeadingLevel,
      text: heading[2]!.trim(),
    };
  });
}

export function serializeOutline(nodes: OutlineNode[]) {
  const markdown = nodes
    .map((node) => (node.kind === "body" ? node.text : `${"#".repeat(node.level)} ${node.text}`))
    .join("\n");
  return nodes.at(-1)?.kind === "body" && nodes.at(-1)?.text === "" ? `${markdown}\n` : markdown;
}
