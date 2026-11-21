import { extensionToLanguage } from "#src/features/files/preview";
import { sharedLowlight } from "#src/features/records/report-editor/lowlight";

type HastRoot = ReturnType<typeof sharedLowlight.highlight>;
type HastNode = HastRoot["children"][number];

export type HighlightedToken = { text: string; className?: string };

const MAX_HIGHLIGHT_CHARS = 256_000;

function classNameOf(node: Extract<HastNode, { type: "element" }>): string | undefined {
  const raw = node.properties?.className;
  if (!Array.isArray(raw)) return undefined;
  const joined = raw.join(" ").trim();
  return joined === "" ? undefined : joined;
}

function splitHastLines(tree: HastRoot): HighlightedToken[][] {
  const lines: HighlightedToken[][] = [[]];

  const pushText = (value: string, className: string | undefined) => {
    const parts = value.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part !== "") {
        lines[lines.length - 1]!.push(className ? { text: part, className } : { text: part });
      }
      if (i < parts.length - 1) lines.push([]);
    }
  };

  const visit = (nodes: HastNode[], classStack: readonly string[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const className = classStack.length > 0 ? classStack.join(" ") : undefined;
        pushText(node.value, className);
      } else if (node.type === "element") {
        const nextClass = classNameOf(node);
        visit(node.children, nextClass ? [...classStack, nextClass] : classStack);
      }
    }
  };

  visit(tree.children, []);
  return lines;
}

export function highlightCodeLines(text: string, path: string): HighlightedToken[][] | null {
  if (text.length > MAX_HIGHLIGHT_CHARS) return null;
  const language = extensionToLanguage(path);
  if (!language || language === "plaintext" || !sharedLowlight.registered(language)) return null;
  const trimmed = text.replace(/\n$/, "");
  try {
    return splitHastLines(sharedLowlight.highlight(language, trimmed));
  } catch {
    return null;
  }
}
