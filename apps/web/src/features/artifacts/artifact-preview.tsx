import Markdown, { type Components } from "react-markdown";
import { memo, type ReactNode } from "react";

import { MESSAGE_REMARK_PLUGINS } from "#src/lib/message-syntax";

const Heading = ({ children }: { children?: ReactNode }) => (
  <p className="mt-2 font-medium text-primary first:mt-0">{children}</p>
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
  input: () => null,
};

export const MarkdownPreview = memo(function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <Markdown remarkPlugins={MESSAGE_REMARK_PLUGINS} components={PREVIEW_COMPONENTS}>
      {markdown}
    </Markdown>
  );
});
