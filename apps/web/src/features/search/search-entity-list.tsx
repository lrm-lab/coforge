import { ChannelGlyph } from "#src/features/conversations/channel-name";
import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { Link } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";

import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import {
  formatAgentProfileParam,
  formatPersonProfileParam,
} from "#src/features/agents/profile-panel/profile-panel-search";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { Badge } from "#src/components/base/badges/badges";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { ComputerGlyph } from "#src/features/computers/computer-status-icon";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { DURATION_S, EASE_IN, EASE_IN_OUT, EASE_OUT } from "#src/utils/motion-tokens";
import { m } from "#src/paraglide/messages";
import type { SearchEntity } from "./search-entities";

export const SEARCH_HEADING_CLASS = "px-2 py-1 text-xs text-tertiary";

export const SEARCH_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-hidden transition-colors hover:bg-secondary_hover focus-visible:bg-chat-selected-bg group-data-[input-focused]/search:data-[search-first]:bg-chat-selected-bg";

export function SearchEntityRow({ entity, onOpen }: { entity: SearchEntity; onOpen: () => void }) {
  const workspaceSlug = useWorkspaceSlug();
  const dmId =
    entity.kind === "dm"
      ? entity.id
      : entity.kind === "person" || (entity.kind === "agent" && entity.canMessage)
        ? entity.dmId
        : null;
  const props = {
    className: `relative ${SEARCH_ROW_CLASS}`,
    onClick: onOpen,
    onAuxClick: (event: { button: number }) => event.button === 1 && onOpen(),
    "data-search-option": "",
    "data-search-entity": `${entity.kind}:${entity.id}`,
    children: <EntityContent entity={entity} />,
  };
  switch (entity.kind) {
    case "channel":
      return <Link {...conversationRoute({ channelId: entity.id }, workspaceSlug)} {...props} />;
    case "computer":
      return (
        <Link
          to="/w/$workspaceSlug/computer/$computerId"
          params={{ workspaceSlug, computerId: entity.id }}
          {...props}
        />
      );
    case "dm":
      return <Link {...conversationRoute({ dmId: entity.id }, workspaceSlug)} {...props} />;
    case "person":
      return dmId ? (
        <Link {...conversationRoute({ dmId }, workspaceSlug)} {...props} />
      ) : (
        <Link
          to="/w/$workspaceSlug/members"
          params={{ workspaceSlug }}
          search={{ profile: formatPersonProfileParam(entity.id) }}
          {...props}
        />
      );
    case "agent":
      return dmId ? (
        <Link {...conversationRoute({ dmId }, workspaceSlug)} {...props} />
      ) : (
        <Link
          to="/w/$workspaceSlug/members"
          params={{ workspaceSlug }}
          search={{ profile: formatAgentProfileParam(entity.id) }}
          {...props}
        />
      );
  }
}

function EntityContent({ entity }: { entity: SearchEntity }) {
  const subtitle = entitySubtitle(entity);
  return (
    <>
      <EntityMark entity={entity} />
      <span className="min-w-0 truncate text-sm text-primary">{entity.name}</span>
      {entity.kind === "channel" && entity.archived && (
        <Badge size="sm" color="gray" type="modern" className="shrink-0">
          {m.search_archived()}
        </Badge>
      )}
      {subtitle && <span className="min-w-0 truncate text-xs text-tertiary">{subtitle}</span>}
    </>
  );
}

const GROUPS = [
  { kind: "person", heading: () => m.search_entity_person() },
  { kind: "agent", heading: () => m.search_entity_agent() },
  { kind: "channel", heading: () => m.search_entity_channel() },
  { kind: "computer", heading: () => m.search_entity_computer() },
] as const;

export function SearchEntityList({
  entities,
  onOpen,
}: {
  entities: readonly SearchEntity[];
  onOpen: (entity: SearchEntity) => void;
}) {
  const reduced = usePrefersReducedMotion();
  return GROUPS.map(({ kind, heading }) => {
    const rows = entities.filter((entity) => entity.kind === kind);
    if (rows.length === 0) return null;
    return (
      <section key={kind} aria-label={heading()} className="flex flex-col px-2 pt-2">
        <h2 className={SEARCH_HEADING_CLASS}>{heading()}</h2>
        <ul className="relative flex flex-col">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((entity) => (
              <motion.li
                key={`${entity.kind}:${entity.id}`}
                layout={reduced ? false : "position"}
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{
                  opacity: 0,
                  transition: { duration: DURATION_S.smOut, ease: EASE_IN },
                }}
                transition={{
                  duration: reduced ? DURATION_S.reduced : DURATION_S.sm,
                  ease: EASE_OUT,
                  layout: { duration: DURATION_S.sm, ease: EASE_IN_OUT },
                }}
              >
                <SearchEntityRow entity={entity} onOpen={() => onOpen(entity)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </section>
    );
  });
}

function entitySubtitle(entity: SearchEntity): string | undefined {
  switch (entity.kind) {
    case "computer":
      return entity.hostname;
    case "agent":
      return `@${entity.handle}`;
    default:
      return undefined;
  }
}

function AgentEntityMark({ entity }: { entity: Extract<SearchEntity, { kind: "agent" }> }) {
  const display = useLiveAgentDisplay(entity.id);
  return (
    <>
      <span aria-hidden="true" className="shrink-0">
        <AgentDisplayAvatar
          agentId={entity.id}
          name={entity.name}
          src={entity.avatarUrl}
          display={display}
          size="xs"
        />
      </span>
      <span className="sr-only">{agentDisplay(display).label}</span>
    </>
  );
}

function EntityMark({ entity }: { entity: SearchEntity }) {
  if (entity.kind === "agent") return <AgentEntityMark entity={entity} />;
  if (entity.kind === "dm" || entity.kind === "person")
    return (
      <span aria-hidden="true" className="shrink-0">
        <ActorAvatar
          presence
          userId={entity.kind === "dm" ? entity.peerId : entity.id}
          name={entity.name}
          src={entity.avatarUrl}
          size="xs"
        />
      </span>
    );
  if (entity.kind === "channel" && entity.members?.length)
    return (
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center">
        <GroupAvatar members={entity.members} className="avatar-group-xs" />
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-fg-quaternary"
    >
      {entity.kind === "channel" ? (
        <ChannelGlyph visibility={entity.visibility} className="size-4" />
      ) : (
        <ComputerGlyph kind={entity.computerKind} className="size-4" />
      )}
    </span>
  );
}
