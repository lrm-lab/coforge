import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSelector } from "@tanstack/react-store";

import { Button } from "#src/components/base/buttons/button";
import { AvatarSticker } from "#src/features/avatars/avatar-sticker";
import {
  COMPOSER_EDGE_PILL_CLASS,
  COMPOSER_EDGE_PILL_SURFACE_CLASS,
} from "#src/features/conversations/composer-edge-pill";
import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";

import { activitySentenceLabel } from "./agent-activity-presentation";
import { AgentListRow } from "./agent-list-popover";
import { AgentMascotView } from "./agent-mascot-view";
import { agentDisplay } from "./agent-status-display";
import { pickBusyAgents } from "./busy-agents";
import { useChannelAgents } from "./channel-agents-context";
import type { OpenAgentProfile } from "./profile-panel/open-agent-profile";
import { replyingAgentIds } from "./reply-intents";
import { useReplyIntentStore } from "./reply-intents-context";
import {
  agentsLineSummary,
  replyingAgentsAmong,
  replyingNames,
  type ReplyingAgent,
} from "./replying-agents-summary";
import { useConversationReplyIntents } from "./reply-intents-realtime";
import {
  useCurrentWorkspaceId,
  useLiveAgent,
  useLiveWorkspaceAgents,
  useVisibleAgentDirectory,
} from "./workspace-agents-realtime";
import "./replying-agents-line.css";

const ID_SEPARATOR = ",";
const GROUP_SEPARATOR = "|";
const EXPANDED_MIN_WIDTH_PX = 240;
const VIEWPORT_MARGIN_PX = 32;
const CLOSE_FALLBACK_MS = 240;
const REDUCED_MOTION_CLOSE_MS = 20;

const idsOf = (joined: string) => (joined ? joined.split(ID_SEPARATOR) : []);

const PILL_CLASS = `${COMPOSER_EDGE_PILL_CLASS} max-w-full ps-1.5 pe-3 text-tertiary`;

type MorphPhase = "closed" | "opening" | "open" | "closing";
type BoxSize = { width: number; height: number };
type AgentRowEntry = { agent: ReplyingAgent; isTyping: boolean };

export function ReplyingAgentsLine({
  conversationId,
  threadRootId,
  className,
}: {
  conversationId: string;
  threadRootId: string | null;
  className?: string;
}) {
  useConversationReplyIntents(useCurrentWorkspaceId(), conversationId);
  const channel = useChannelAgents(conversationId, threadRootId);
  const typingIds = useReplyingAgentIds(conversationId, threadRootId);
  const workingIds = useWorkingAgentIds(channel?.agentIds);
  const current = typingIds || workingIds ? `${typingIds}${GROUP_SEPARATOR}${workingIds}` : "";
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);
  const leaving = !current && shown !== "";
  const [shownTyping = "", shownWorking = ""] = shown.split(GROUP_SEPARATOR);
  return (
    <div className={className}>
      {shown && (
        <ComposerAgentsPill
          typingIds={shownTyping}
          workingIds={shownWorking}
          listsAgents={channel !== undefined}
          onOpenAgentProfile={channel?.onOpenAgentProfile}
          leaving={leaving}
          onLeft={() => setShown("")}
        />
      )}
    </div>
  );
}

export function ThreadReplyingLine({
  conversationId,
  rootId,
}: {
  conversationId: string;
  rootId: string;
}) {
  const replyingIds = useReplyingAgentIds(conversationId, rootId);
  return replyingIds ? <ThreadReplyingAgents replyingIds={replyingIds} /> : null;
}

function useReplyingAgentIds(conversationId: string, threadRootId: string | null) {
  const [live] = useLiveAgentActivity();
  const intents = useReplyIntentStore();
  return useSelector(intents.store, (entries) =>
    live ? replyingAgentIds(entries, conversationId, threadRootId).join(ID_SEPARATOR) : "",
  );
}

function useWorkingAgentIds(channelAgentIds?: readonly string[]) {
  const [live] = useLiveAgentActivity();
  const members = useMemo(() => new Set(channelAgentIds), [channelAgentIds]);
  return useLiveWorkspaceAgents((agents) =>
    live && channelAgentIds ? pickBusyAgents(agents.filter((agent) => members.has(agent.id))) : [],
  )
    .map((agent) => agent.id)
    .join(ID_SEPARATOR);
}

const SENTENCES = {
  typing: {
    one: m.agent_replying_one,
    many: m.agent_replying_many,
    overflow: m.agent_replying_overflow,
  },
  replying: {
    one: m.agent_thread_replying_one,
    many: m.agent_thread_replying_many,
    overflow: m.agent_thread_replying_overflow,
  },
};

function namingClause(kind: keyof typeof SENTENCES, agents: readonly ReplyingAgent[]) {
  const names = replyingNames(
    agents.map((agent) => agent.name),
    getLocale(),
  );
  const messages = SENTENCES[kind];
  return names.kind === "overflow"
    ? messages.overflow(names)
    : names.plural
      ? messages.many({ names: names.text })
      : messages.one({ names: names.text });
}

function AgentFaces({ agents }: { agents: readonly ReplyingAgent[] }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center">
      {agents.map((agent, index) => (
        <AvatarSticker
          key={agent.id}
          size="xs"
          className={cx(
            "size-4 transition-[translate,opacity] duration-(--duration-sm) ease-out-strong starting:opacity-0 motion-safe:starting:-translate-x-1",
            index > 0 && "-ms-1.25",
          )}
        >
          <AgentMascotView mascot={agent.mascot} activity="working" />
        </AvatarSticker>
      ))}
    </span>
  );
}

function ThreadReplyingAgents({ replyingIds }: { replyingIds: string }) {
  const agents = useVisibleAgentDirectory();
  const replying = useMemo(
    () => replyingAgentsAmong(agents, idsOf(replyingIds)),
    [agents, replyingIds],
  );
  const summary = agentsLineSummary(replying, []);
  if (!summary) return null;
  return (
    <div className="replying-line mt-1.5 flex min-h-6 max-w-full items-center gap-1.5 px-1 text-xs">
      <AgentFaces agents={summary.faces} />
      <p role="status" className="min-w-0 truncate text-tertiary">
        {namingClause("replying", replying)}
      </p>
    </div>
  );
}

function expandedWidthFor(collapsedWidth: number) {
  const viewportLimit =
    typeof window === "undefined"
      ? EXPANDED_MIN_WIDTH_PX
      : Math.max(collapsedWidth, window.innerWidth - VIEWPORT_MARGIN_PX);
  return Math.min(Math.max(collapsedWidth, EXPANDED_MIN_WIDTH_PX), viewportLimit);
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function ExpandableAgentsPill({
  content,
  entries,
  leaving,
  onOpenAgentProfile,
}: {
  content: ReactNode;
  entries: readonly AgentRowEntry[];
  leaving: boolean;
  onOpenAgentProfile?: OpenAgentProfile;
}) {
  const listId = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const listWrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreFocusRef = useRef(false);

  const [phase, setPhase] = useState<MorphPhase>("closed");
  const [anchorSize, setAnchorSize] = useState<BoxSize | null>(null);
  const [shellSize, setShellSize] = useState<BoxSize | null>(null);
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });

  const updateScrollFade = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    const overflow = node.scrollHeight > node.clientHeight + 1;
    const top = overflow && node.scrollTop > 4;
    const bottom = overflow && node.scrollTop + node.clientHeight < node.scrollHeight - 4;
    setScrollFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  const finishClose = useCallback(() => {
    setPhase("closed");
    setAnchorSize(null);
    setShellSize(null);
    setScrollFade({ top: false, bottom: false });
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      requestAnimationFrame(() => shellRef.current?.querySelector("button")?.focus());
    }
  }, []);

  const closePill = useCallback(
    (restoreFocus = false) => {
      if (phase === "closed" || phase === "closing") return;
      restoreFocusRef.current = restoreFocus;
      if (!anchorSize) {
        finishClose();
        return;
      }
      setShellSize(anchorSize);
      setPhase("closing");
    },
    [anchorSize, finishClose, phase],
  );

  const openPill = useCallback(() => {
    if (phase !== "closed" || leaving) return;
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect) return;
    const collapsed = { width: rect.width, height: rect.height };
    setAnchorSize(collapsed);
    setShellSize(collapsed);
    setPhase("opening");
  }, [leaving, phase]);

  useEffect(() => {
    if (leaving && phase !== "closed") {
      restoreFocusRef.current = false;
      finishClose();
    }
  }, [finishClose, leaving, phase]);

  useLayoutEffect(() => {
    if (phase !== "opening" || !anchorSize) return;
    const wrap = listWrapRef.current;
    const list = listRef.current;
    if (!wrap || !list) return;
    list.scrollTop = 0;
    const target = {
      width: expandedWidthFor(anchorSize.width),
      height: wrap.offsetHeight,
    };
    const frame = requestAnimationFrame(() => {
      setShellSize(target);
      setPhase("open");
      updateScrollFade();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorSize, phase, updateScrollFade]);

  useEffect(() => {
    if (phase !== "open" || !anchorSize) return;
    const wrap = listWrapRef.current;
    if (!wrap) return;
    const syncHeight = () => {
      setShellSize({
        width: expandedWidthFor(anchorSize.width),
        height: wrap.offsetHeight,
      });
      updateScrollFade();
    };
    syncHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncHeight);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [anchorSize, entries.length, phase, updateScrollFade]);

  useEffect(() => {
    if (phase !== "closing") return;
    const timeout = window.setTimeout(
      finishClose,
      prefersReducedMotion() ? REDUCED_MOTION_CLOSE_MS : CLOSE_FALLBACK_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [finishClose, phase]);

  useEffect(() => {
    if (phase !== "opening" && phase !== "open") return;
    const onPointerDown = (event: PointerEvent) => {
      if (shellRef.current && !shellRef.current.contains(event.target as Node)) {
        closePill(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePill(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closePill, phase]);

  const active = phase !== "closed";
  const expanded = phase === "open";
  const shellStyle =
    active && shellSize ? { width: shellSize.width, height: shellSize.height } : undefined;
  const anchorStyle = active && anchorSize ? { width: anchorSize.width } : undefined;

  return (
    <div className="relative h-8 max-w-full" style={anchorStyle}>
      <div
        ref={shellRef}
        data-phase={phase}
        style={shellStyle}
        onTransitionEnd={(event) => {
          if (
            phase === "closing" &&
            event.target === event.currentTarget &&
            (event.propertyName === "height" || event.propertyName === "width")
          ) {
            finishClose();
          }
        }}
        className={cx(
          "pointer-events-auto overflow-hidden",
          active
            ? cx(
                "replying-morph-shell absolute start-0 bottom-0 z-20",
                COMPOSER_EDGE_PILL_SURFACE_CLASS,
                expanded && "shadow-lg",
              )
            : "inline-flex h-8 max-w-full",
        )}
      >
        <Button
          color="tertiary"
          size="xs"
          noTextPadding
          aria-expanded={expanded}
          aria-controls={active ? listId : undefined}
          onPress={openPill}
          className={cx(
            active
              ? "replying-morph-pill absolute inset-x-0 bottom-0 h-8 w-full justify-start rounded-2xl bg-transparent py-0 ps-1.5 pe-3 text-xs font-normal text-tertiary hover:bg-primary_hover hover:text-tertiary [&>[data-text]]:flex [&>[data-text]]:min-w-0 [&>[data-text]]:items-center [&>[data-text]]:gap-1.5"
              : cx(
                  PILL_CLASS,
                  "min-w-[min(15rem,100%)] justify-start py-0 font-normal hover:bg-primary_hover hover:text-tertiary [&>[data-text]]:flex [&>[data-text]]:min-w-0 [&>[data-text]]:items-center [&>[data-text]]:gap-1.5",
                ),
          )}
        >
          {content}
        </Button>
        {active && (
          <div
            ref={listWrapRef}
            id={listId}
            role="region"
            aria-label={m.agent_busy_agents()}
            className="replying-morph-list absolute inset-x-0 bottom-0"
          >
            <div
              aria-hidden="true"
              className={cx(
                "pointer-events-none absolute inset-x-0 top-0 z-10 h-5 bg-linear-to-b from-bg-primary to-transparent transition-opacity duration-150",
                scrollFade.top ? "opacity-100" : "opacity-0",
              )}
            />
            <ul
              ref={listRef}
              onScroll={updateScrollFade}
              className="max-h-[min(14rem,45dvh)] overflow-y-auto overscroll-contain py-1 [scrollbar-width:thin]"
            >
              {entries.map(({ agent, isTyping }) => (
                <AgentsLineRow
                  key={agent.id}
                  agent={agent}
                  isTyping={isTyping}
                  onOpen={
                    onOpenAgentProfile
                      ? () => {
                          closePill(false);
                          onOpenAgentProfile(agent.id);
                        }
                      : undefined
                  }
                />
              ))}
            </ul>
            <div
              aria-hidden="true"
              className={cx(
                "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-5 bg-linear-to-t from-bg-primary to-transparent transition-opacity duration-150",
                scrollFade.bottom ? "opacity-100" : "opacity-0",
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ComposerAgentsPill({
  typingIds,
  workingIds,
  listsAgents,
  onOpenAgentProfile,
  leaving,
  onLeft,
}: {
  typingIds: string;
  workingIds: string;
  listsAgents: boolean;
  onOpenAgentProfile?: OpenAgentProfile;
  leaving: boolean;
  onLeft: () => void;
}) {
  const agents = useVisibleAgentDirectory();
  const typing = useMemo(() => replyingAgentsAmong(agents, idsOf(typingIds)), [agents, typingIds]);
  const working = useMemo(
    () => replyingAgentsAmong(agents, idsOf(workingIds)),
    [agents, workingIds],
  );
  const summary = agentsLineSummary(typing, working);
  if (!summary) return null;
  const typingClause = typing.length > 0 ? namingClause("typing", typing) : "";
  const typingAlone = typingClause ? m.agent_typing_alone({ typing: typingClause }) : "";
  const sentence =
    summary.sentence === "typing"
      ? typingAlone
      : summary.sentence === "working"
        ? m.agent_working_here({ count: summary.others.length })
        : m.agent_typing_and_working({ typing: typingClause, others: summary.others.length });
  const content = (
    <>
      <AgentFaces agents={summary.faces} />
      <span className="min-w-0 truncate">{sentence}</span>
    </>
  );
  const entries: AgentRowEntry[] = [
    ...typing.map((agent) => ({ agent, isTyping: true })),
    ...summary.others.map((agent) => ({ agent, isTyping: false })),
  ];
  return (
    <>
      <span role="status" className="sr-only">
        {typingAlone}
      </span>
      <div
        data-leaving={leaving || undefined}
        onAnimationEnd={(event) => {
          if (leaving && event.target === event.currentTarget) onLeft();
        }}
        className="replying-line inline-flex max-w-full"
      >
        {listsAgents ? (
          <ExpandableAgentsPill
            content={content}
            entries={entries}
            leaving={leaving}
            onOpenAgentProfile={onOpenAgentProfile}
          />
        ) : (
          <div aria-hidden="true" className={cx(PILL_CLASS, "inline-flex items-center gap-1.5")}>
            {content}
          </div>
        )}
      </div>
    </>
  );
}

function AgentsLineRow({
  agent,
  isTyping,
  onOpen,
}: {
  agent: ReplyingAgent;
  isTyping: boolean;
  onOpen?: () => void;
}) {
  const display = useLiveAgent(agent.id)?.display;
  const caption = isTyping
    ? m.agent_typing_row()
    : display && activitySentenceLabel(agentDisplay(display).label);
  return (
    <AgentListRow
      agentId={agent.id}
      name={agent.name}
      mascot={agent.mascot}
      display={display}
      caption={caption}
      onOpenProfile={onOpen}
    />
  );
}
