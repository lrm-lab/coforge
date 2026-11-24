import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Link, useRouter } from "@tanstack/react-router";
import Markdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { Element } from "hast";

import { MESSAGE_REMARK_PLUGINS, messageSource } from "#src/lib/message-syntax";
import { MessageFormula } from "./message-formula";
import { AgentMentionChip, PersonMentionChip } from "./mention-chip-hover";
import { followInternalLinkClick, internalAppHref } from "./internal-app-href";
import { mentionHandlesByToken, rehypeReferenceChips } from "./message-markdown";
import type { ChipMention } from "./message-reference-chips";
import { rehypeTrailingSlot } from "./message-trailing-slot";
import { rehypeCjkBreaks } from "./message-cjk-breaks";
import type { MentionRef } from "./mention-text";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import {
  CrossTaskReference,
  DirectTaskReferenceByPeer,
} from "#src/features/tasks/cross-task-reference";
import { TaskReference } from "#src/features/tasks/task-reference";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import "./message-markdown.css";

const EMPTY_MENTIONS: readonly MentionRef[] = [];

type MessageMarkdownProps = {
  body: string;
  mentions: readonly MentionRef[];
  plainMentions?: Map<string, ChipMention>;
  viewerId?: string;
  onOpenAgentProfile?: OpenAgentProfile;
  onOpenPersonProfile?: OpenPersonProfile;
  onOpenTask?: (number: number) => void;
  channelNames?: ReadonlyMap<string, string>;
  hasTrailing: boolean;
};

const MessageMarkdownContent = memo(function MessageMarkdownContent({
  body,
  mentions,
  plainMentions,
  viewerId,
  onOpenAgentProfile,
  onOpenPersonProfile,
  onOpenTask,
  channelNames,
  hasTrailing,
}: MessageMarkdownProps) {
  const source = useMemo(() => messageSource(body), [body]);
  const handles = useMemo(() => mentionHandlesByToken(mentions), [mentions]);
  const hasReference =
    source.includes("<@") ||
    source.includes(":#") ||
    (plainMentions !== undefined && plainMentions.size > 0);
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(() => {
    const plugins: NonNullable<Options["rehypePlugins"]> = [rehypeSanitize];
    if (hasReference)
      plugins.push([
        rehypeReferenceChips,
        { mentions: handles, viewerId, plainMentions, channelNames },
      ]);
    plugins.push(rehypeCjkBreaks);
    if (hasTrailing) plugins.push(rehypeTrailingSlot);
    return plugins;
  }, [hasReference, handles, viewerId, plainMentions, channelNames, hasTrailing]);
  const components = useMemo<Components>(
    () => ({
      ...MARKDOWN_COMPONENTS,
      span: chipSpan(onOpenAgentProfile, onOpenPersonProfile, onOpenTask),
    }),
    [onOpenAgentProfile, onOpenPersonProfile, onOpenTask],
  );

  return (
    <Markdown
      remarkPlugins={MESSAGE_REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {source}
    </Markdown>
  );
});

export const MessageBody = memo(function MessageBody({
  body,
  mentions = EMPTY_MENTIONS,
  plainMentions,
  viewerId,
  onOpenAgentProfile,
  onOpenPersonProfile,
  onOpenTask,
  channelNames,
  trailing,
}: {
  body: string;
  mentions?: readonly MentionRef[];
  plainMentions?: Map<string, ChipMention>;
  viewerId?: string;
  onOpenAgentProfile?: OpenAgentProfile;
  onOpenPersonProfile?: OpenPersonProfile;
  onOpenTask?: (number: number) => void;
  channelNames?: ReadonlyMap<string, string>;
  trailing?: ReactNode;
}) {
  const hasTrailing = trailing !== undefined && trailing !== null;
  return (
    <div className="message-markdown">
      <TrailingContext.Provider value={trailing}>
        <MessageMarkdownContent
          body={body}
          mentions={mentions}
          plainMentions={plainMentions}
          viewerId={viewerId}
          onOpenAgentProfile={onOpenAgentProfile}
          onOpenPersonProfile={onOpenPersonProfile}
          onOpenTask={onOpenTask}
          channelNames={channelNames}
          hasTrailing={hasTrailing}
        />
      </TrailingContext.Provider>
    </div>
  );
});

const TrailingContext = createContext<ReactNode>(undefined);

function TrailingSlot() {
  return useContext(TrailingContext);
}

const MARKDOWN_COMPONENTS = {
  pre: CodeBlock,
  code: InlineCode,
  img: ImageLink,
  a: ExternalLink,
  table: ({ children }: ComponentPropsWithoutRef<"table">) => (
    <div className="message-markdown-table">
      <table>{children}</table>
    </div>
  ),
};

function ChannelChipLink({
  channelId,
  threadRootId,
  className,
  children,
}: {
  channelId: string;
  threadRootId?: string;
  className?: string;
  children: ReactNode;
}) {
  const workspaceSlug = useWorkspaceSlug();
  if (threadRootId === undefined) {
    return (
      <Link
        to="/w/$workspaceSlug/channel/$channelId"
        params={{ workspaceSlug, channelId }}
        className={className}
        data-channel-id={channelId}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/w/$workspaceSlug/channel/$channelId"
      params={{ workspaceSlug, channelId }}
      search={{ threadRootId }}
      resetScroll={false}
      className={className}
      data-thread-channel-id={channelId}
      data-thread-root-id={threadRootId}
    >
      {children}
    </Link>
  );
}

function chipSpan(
  onOpenAgentProfile?: OpenAgentProfile,
  onOpenPersonProfile?: OpenPersonProfile,
  onOpenTask?: (number: number) => void,
) {
  return function ChipSpan({
    node,
    children,
    className,
    ...props
  }: ComponentPropsWithoutRef<"span"> & ExtraProps) {
    void node;
    const data = props as Record<string, unknown>;
    if (data["data-trailing-slot"] !== undefined) return <TrailingSlot />;
    const channelId = data["data-channel-id"];
    if (typeof channelId === "string") {
      return (
        <ChannelChipLink channelId={channelId} className={className}>
          {children}
        </ChannelChipLink>
      );
    }
    const threadChannelId = data["data-thread-channel-id"];
    const threadRootId = data["data-thread-root-id"];
    if (typeof threadChannelId === "string" && typeof threadRootId === "string") {
      return (
        <ChannelChipLink
          channelId={threadChannelId}
          threadRootId={threadRootId}
          className={className}
        >
          {children}
        </ChannelChipLink>
      );
    }
    const taskNumber = data["data-task-reference-number"];
    const taskConversationId = data["data-task-reference-conversation-id"];
    const taskKind = data["data-task-reference-kind"];
    if (
      typeof taskNumber === "number" &&
      typeof taskConversationId === "string" &&
      (taskKind === "channel" || taskKind === "dm")
    ) {
      return (
        <CrossTaskReference
          conversationId={taskConversationId}
          number={taskNumber}
          kind={taskKind}
          onOpenTask={onOpenTask}
          prose={data["data-task-reference-prose"] === "true"}
        >
          {children}
        </CrossTaskReference>
      );
    }
    const taskPeer = data["data-task-reference-peer"];
    if (typeof taskNumber === "number" && taskKind === "dm" && typeof taskPeer === "string") {
      return (
        <DirectTaskReferenceByPeer peer={taskPeer} number={taskNumber} onOpenTask={onOpenTask}>
          {children}
        </DirectTaskReferenceByPeer>
      );
    }
    if (typeof taskNumber === "number") {
      return (
        <TaskReference {...props} number={taskNumber} onOpenTask={onOpenTask}>
          {children}
        </TaskReference>
      );
    }
    const agentId = data["data-mention-agent-id"];
    const userId = data["data-mention-user-id"];
    const label = data["data-mention-label"];
    if (typeof agentId === "string" && typeof label === "string" && onOpenAgentProfile) {
      return (
        <AgentMentionChip
          agentId={agentId}
          label={label}
          className={className}
          onOpenProfile={onOpenAgentProfile}
        >
          {children}
        </AgentMentionChip>
      );
    }
    if (typeof userId === "string" && typeof label === "string" && onOpenPersonProfile) {
      return (
        <PersonMentionChip
          userId={userId}
          label={label}
          className={className}
          onOpenProfile={onOpenPersonProfile}
        >
          {children}
        </PersonMentionChip>
      );
    }
    return (
      <span {...props} className={className}>
        {children}
      </span>
    );
  };
}

function CodeBlock({ node, children, ...props }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const code = node?.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  const className = code?.properties?.className;
  const language = Array.isArray(className)
    ? className.find((name) => name.startsWith("language-"))?.slice("language-".length)
    : undefined;
  if (language === "math") return <MessageFormula source={textOf(code)} display />;

  return (
    <div className="message-markdown-code">
      {language && <span className="message-markdown-code-language">{language}</span>}
      <pre {...props}>{children}</pre>
    </div>
  );
}

function InlineCode({
  node,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & ExtraProps) {
  if (className?.split(" ").includes("language-math"))
    return <MessageFormula source={textOf(node)} display={false} />;
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function textOf(node: Element | undefined): string {
  return (node?.children ?? []).map((child) => (child.type === "text" ? child.value : "")).join("");
}

function ExternalLink({
  node,
  children,
  href,
  ...props
}: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  void node;
  const router = useRouter();
  const internal = internalAppHref(typeof href === "string" ? href : undefined);
  if (internal) {
    const { target: _target, ...rest } = props;
    void _target;
    return (
      <a
        {...rest}
        href={internal}
        onClick={(event) => {
          if (!followInternalLinkClick(event)) return;
          event.preventDefault();
          void router.navigate({ href: internal });
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function ImageLink({ node, src, alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  void node;
  const label = alt?.trim() || src || "";
  if (!src) return <span>{label}</span>;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="message-markdown-image">
      {label}
    </a>
  );
}
