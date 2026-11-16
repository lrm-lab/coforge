import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ReactNode } from "react";

const MARKDOWN_MARKER = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
const PLAIN_LINES = 2;
const PLAIN_LINE_CHARACTERS = 200;

export function plainPreview(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(MARKDOWN_MARKER, "").trim().slice(0, PLAIN_LINE_CHARACTERS))
    .filter((line) => line !== "")
    .slice(0, PLAIN_LINES)
    .join("\n");
}

const Heading = ({ children }: { children?: ReactNode }) => (
  <p className="mt-2 font-semibold text-primary first:mt-0">{children}</p>
);

const Paragraph = ({ children }: { children?: ReactNode }) => (
  <p className="mt-1.5 first:mt-0">{children}</p>
);

const PREVIEW_COMPONENTS: Components = {
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  h5: Heading,
  h6: Heading,
  p: Paragraph,
  a: ({ children }) => <span>{children}</span>,
  img: () => null,
  ul: ({ children }) => <ul className="mt-1.5 list-disc pl-4 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1.5 list-decimal pl-4 first:mt-0">{children}</ol>,
  pre: ({ children }) => (
    <pre className="mt-1.5 overflow-hidden rounded bg-secondary p-1.5 font-mono whitespace-pre-wrap first:mt-0">
      {children}
    </pre>
  ),
  table: () => null,
};

export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={PREVIEW_COMPONENTS}>
      {markdown}
    </Markdown>
  );
}
