import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import { MESSAGE_REMARK_PLUGINS, messageSource } from "#src/lib/message-syntax";
import { mentionHandlesByToken, rehypeReferenceChips } from "./message-markdown";
import type { MentionRef } from "./mention-text";

const EMPTY_MENTIONS: readonly MentionRef[] = [];

export const MessagePreview = memo(function MessagePreview({
  body,
  mentions = EMPTY_MENTIONS,
}: {
  body: string;
  mentions?: readonly MentionRef[];
}) {
  const source = useMemo(() => messageSource(body), [body]);
  const handles = useMemo(() => mentionHandlesByToken(mentions), [mentions]);
  const hasReference = source.includes("<@");
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () =>
      hasReference
        ? [rehypeSanitize, [rehypeReferenceChips, { mentions: handles }]]
        : [rehypeSanitize],
    [hasReference, handles],
  );
  return (
    <Markdown
      remarkPlugins={MESSAGE_REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      components={PREVIEW_COMPONENTS}
    >
      {source}
    </Markdown>
  );
});

function Inline({ children }: ComponentPropsWithoutRef<"span">) {
  return <span>{children}</span>;
}

function InlineWithSpace({ children }: ComponentPropsWithoutRef<"span">) {
  return <span>{children} </span>;
}

function Space() {
  return <span> </span>;
}

const PREVIEW_COMPONENTS: Components = {
  p: InlineWithSpace,
  h1: InlineWithSpace,
  h2: InlineWithSpace,
  h3: InlineWithSpace,
  h4: InlineWithSpace,
  h5: InlineWithSpace,
  h6: InlineWithSpace,
  blockquote: Inline,
  ul: Inline,
  ol: Inline,
  li: InlineWithSpace,
  table: Inline,
  section: Inline,
  sup: Inline,
  thead: Inline,
  tbody: Inline,
  tr: InlineWithSpace,
  th: InlineWithSpace,
  td: InlineWithSpace,
  br: Space,
  hr: Space,
  input: () => null,
  pre: ({ children }) => <span className="font-mono">{children}</span>,
  code: ({ children }) => (
    <code className="rounded-sm bg-secondary px-1 font-mono text-xs">{children}</code>
  ),
  a: ({ children }) => <span className="text-(--color-reference-text) underline">{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
};
