import { channelGlyph } from "#src/features/conversations/channel-name";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { channelLabel } from "#src/features/conversations/channel-visibility";
import { Link } from "@tanstack/react-router";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useAgentDisplays } from "#src/features/agents/workspace-agents-realtime";
import { Badge } from "#src/components/base/badges/badges";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { computerIcon } from "#src/features/computers/computer-identity";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { m } from "#src/paraglide/messages";
import type { SearchEntity } from "./search-entities";

export const SEARCH_HEADING_CLASS = "px-2 py-1 text-xs text-tertiary";

/** A row in the dialog's lists; the first shows as chosen while the box has focus. */
export const SEARCH_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-hidden transition-colors hover:bg-secondary focus-visible:bg-brand-primary_alt group-has-[input:focus]/search:data-[search-first]:bg-brand-primary_alt";

/**
 * An entity as a link to where it opens: a channel itself; the viewer's own Agent its direct
 * messages (the Web opens an Agent's DM only for its owner), any other Agent its profile; a
 * Computer its page; a direct message with a member that DM. Each branch is its own `Link`, so the
 * router checks every destination. `onOpen` runs as it opens.
 */
export function SearchEntityRow({
  entity,
  display,
  onOpen,
}: {
  entity: SearchEntity;
  display: AgentDisplaySnapshot | undefined;
  onOpen: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  // The viewer's DM with an Agent they may message, once there is one, or with a member.
  const dmId =
    entity.kind === "dm"
      ? entity.id
      : entity.kind === "agent" && entity.canMessage
        ? entity.dmId
        : null;
  const props = {
    // `relative` keeps an Agent's `sr-only` status text inside its row. Unpositioned, it escaped
    // the dialog's scroll box and stretched the document.
    className: `relative ${SEARCH_ROW_CLASS}`,
    onClick: onOpen,
    // A middle click opens a new tab without a click event; it is still an open.
    onAuxClick: (event: { button: number }) => event.button === 1 && onOpen(),
    "data-search-option": "",
    "data-search-entity": `${entity.kind}:${entity.id}`,
    children: <EntityContent entity={entity} display={display} />,
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
    case "agent":
      // Opens the viewer's DM with the Agent when there is one, as in Chat; else its profile.
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

function EntityContent({
  entity,
  display,
}: {
  entity: SearchEntity;
  display: AgentDisplaySnapshot | undefined;
}) {
  const subtitle = entitySubtitle(entity);
  return (
    <>
      <EntityMark entity={entity} display={display} />
      <span className="min-w-0 truncate text-sm text-primary">
        {entity.kind === "channel" ? channelLabel(entity) : entity.name}
      </span>
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
  { kind: "channel", heading: () => m.search_entity_channel() },
  { kind: "agent", heading: () => m.search_entity_agent() },
  { kind: "computer", heading: () => m.search_entity_computer() },
] as const;

/** The channels, Computers and Agents a query names, listed above the messages. */
export function SearchEntityList({
  entities,
  onOpen,
}: {
  entities: readonly SearchEntity[];
  onOpen: (entity: SearchEntity) => void;
}) {
  const displays = useAgentDisplays();
  return GROUPS.map(({ kind, heading }) => {
    const rows = entities.filter((entity) => entity.kind === kind);
    if (rows.length === 0) return null;
    return (
      <section key={kind} aria-label={heading()} className="flex flex-col px-2 pt-2">
        <h2 className={SEARCH_HEADING_CLASS}>{heading()}</h2>
        <ul className="flex flex-col">
          {rows.map((entity) => (
            <li key={`${entity.kind}:${entity.id}`}>
              <SearchEntityRow
                entity={entity}
                display={displays.get(entity.id)}
                onOpen={() => onOpen(entity)}
              />
            </li>
          ))}
        </ul>
      </section>
    );
  });
}

/** The line after the name: where a Computer runs, an Agent's `@handle`.
 * A member has none: their username is not shown. */
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

/** The row's leading mark: the channel icon, the Computer's icon, an Agent's live avatar, the
 * member's avatar. */
function EntityMark({
  entity,
  display,
}: {
  entity: SearchEntity;
  display: AgentDisplaySnapshot | undefined;
}) {
  if (entity.kind === "agent") {
    // The row's own text names the Agent, so the avatar is hidden from screen readers; its live
    // status, which the dot shows, is read out on its own.
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
  if (entity.kind === "dm")
    // The row's own text names the member.
    return (
      <span aria-hidden="true" className="shrink-0">
        <ActorAvatar
          presence
          userId={entity.peerId}
          name={entity.name}
          src={entity.avatarUrl}
          size="xs"
        />
      </span>
    );
  const Icon =
    entity.kind === "channel"
      ? channelGlyph(entity)
      : computerIcon({
          kind: entity.computerKind,
          name: entity.hostname,
          displayName: entity.name,
        });
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-fg-quaternary"
    >
      <Icon className="size-4" />
    </span>
  );
}
