import { FileIcon } from "@untitledui/file-icons";

import { cn } from "#src/lib/utils";

/** Extensions Untitled's file icons do not name, but still categorize. Markdown is `text/markdown`,
 * which that set draws as code. The rest are source files with no dedicated glyph. */
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
const CODE_EXTENSIONS = new Set([
  "bash",
  "cjs",
  "cts",
  "go",
  "jsx",
  "mjs",
  "mts",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "svelte",
  "toml",
  "ts",
  "tsx",
  "vue",
  "yaml",
  "yml",
]);

/** The Untitled file-icon type for one tree row. A known extension wins. Anything else is the
 * empty file glyph, not a second copy of the folder. */
export function treeFileIconType(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (!extension || extension.length > 12 || /\s/.test(extension)) return "empty";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "text/markdown";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  // A known extension (`png`, `json`) is drawn as that glyph. An unknown one falls back to empty.
  return extension;
}

/** The file glyph in a tree row. Light and dark are the icon set's own themes. */
export function TreeFileIcon({
  name,
  className = "size-4",
  size = 16,
}: {
  name: string;
  className?: string;
  size?: number;
}) {
  const type = treeFileIconType(name);
  const iconClassName = cn("shrink-0", className);
  return (
    <>
      <FileIcon
        type={type}
        theme="light"
        size={size}
        className={cn("dark:hidden", iconClassName)}
      />
      <FileIcon
        type={type}
        theme="dark"
        size={size}
        className={cn("not-dark:hidden", iconClassName)}
      />
    </>
  );
}
