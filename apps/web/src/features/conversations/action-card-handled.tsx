import { Link } from "@tanstack/react-router";

import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { AnsweredAtTooltip, type FocusableLink } from "./action-card-answered-at";
import { actionCardHandledVerb } from "./action-card-labels";
import { namesOf } from "./action-card-object";

/** What a handled card made: its words and, where the thing has an id, where it opens. */
type Outcome = {
  text: string;
  target?: { kind: "channel"; channelId: string } | { kind: "agent"; agentId: string };
};

/** The made thing (or, for a card closed without being done, the thing it would have made). Only
 * a done card has a `result`. */
function outcomeOf(view: ActionCardView): Outcome | undefined {
  switch (view.kind) {
    case "channel:create":
      return {
        text: `#${view.name}`,
        target: view.result ? { kind: "channel", channelId: view.result.channelId } : undefined,
      };
    case "agent:create":
      return {
        text: view.name,
        target: view.result ? { kind: "agent", agentId: view.result.agentId } : undefined,
      };
    case "channel:add_member": {
      // What was added is what the person kept of the proposal, and the channel opens only for
      // someone who can read it (its id is null to anyone else).
      const kept = new Set([...(view.result?.userIds ?? []), ...(view.result?.agentIds ?? [])]);
      const proposed = [...view.humans, ...view.agents];
      const people = view.result ? proposed.filter((person) => kept.has(person.id)) : proposed;
      const channel = `#${view.channel.displayName}`;
      return {
        text: people.length ? `${namesOf(people)} → ${channel}` : channel,
        target:
          view.result && view.channel.id
            ? { kind: "channel", channelId: view.channel.id }
            : undefined,
      };
    }
    case "page:fill":
    case "desktop:takeover":
      return view.prompt ? { text: view.prompt } : undefined;
    case "app:grant_agent":
      return { text: view.app.name };
    case "app:register":
      // The key names the app in Settings, which the name alone may not.
      return {
        text: view.result ? `${view.app.name} (${view.result.clientKey})` : view.app.name,
      };
    case "app:recover_owner":
      return {
        text: view.result ? `${view.result.ownerAgent} → ${view.app.name}` : view.app.name,
      };
    default:
      return undefined;
  }
}

const LINK_CLASS =
  "rounded-sm font-medium text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2";

/** The link itself, built here and not wrapped in a component: the tooltip's `Focusable` hands its
 * hover and focus props to the element it is given, which must be the one that renders the anchor. */
function outcomeLink(
  workspaceSlug: string,
  target: NonNullable<Outcome["target"]>,
  text: string,
): FocusableLink {
  return target.kind === "channel" ? (
    <Link
      to="/w/$workspaceSlug/channel/$channelId"
      params={{ workspaceSlug, channelId: target.channelId }}
      className={LINK_CLASS}
    >
      {text}
    </Link>
  ) : (
    <Link
      to="/w/$workspaceSlug/members"
      params={{ workspaceSlug }}
      search={{ profile: formatAgentProfileParam(target.agentId), agentTab: "profile" }}
      className={LINK_CLASS}
    >
      {text}
    </Link>
  );
}

/**
 * A handled card is no longer a card but one line in the message, as a handled choice is: what was
 * done in gray, then what it made, a link where there is one to open. Someone else's commit is
 * followed by their name; the viewer's own is not. When it was done is the result's tooltip, as a
 * message's own time is. A card closed without being done keeps the action and what it named, then
 * says so in gray (task #449).
 */
export function HandledActionCard({ view }: { view: ActionCardView }) {
  const workspaceSlug = useWorkspaceSlug();
  const outcome = outcomeOf(view);
  const verb = actionCardHandledVerb(view);
  if (view.state === "cancelled")
    return (
      <p className="text-sm wrap-anywhere text-tertiary">
        <span className="mr-1">{verb}</span>{" "}
        {outcome && <span className="mr-1.5">{outcome.text}</span>}{" "}
        <span className="text-quaternary">
          {view.kind === "app:grant_agent" ? m.app_card_denied() : m.action_card_cancelled()}
        </span>
      </p>
    );
  const by =
    view.committedBy && !view.committedBy.isViewer ? view.committedBy.displayName : undefined;
  const at = view.committedAt;
  const link = outcome?.target && outcomeLink(workspaceSlug, outcome.target, outcome.text);
  const result = outcome && !link && (
    <span className="font-medium text-primary">{outcome.text}</span>
  );
  return (
    <div className="text-sm wrap-anywhere text-tertiary">
      <p>
        {/* With nothing made to point at, the verb itself carries the time. */}
        <span className="mr-1">
          {at && !outcome ? <AnsweredAtTooltip at={at}>{verb}</AnsweredAtTooltip> : verb}
        </span>{" "}
        {at && link ? (
          <AnsweredAtTooltip at={at} link={link} />
        ) : at && result ? (
          <AnsweredAtTooltip at={at}>{result}</AnsweredAtTooltip>
        ) : (
          (link ?? result)
        )}
        {by && <span className="ml-1.5 text-quaternary">· {by}</span>}
      </p>
      {view.kind === "app:register" && view.result && (
        <p className="pt-1 text-xs text-tertiary">
          {view.result.noOwnerAgent
            ? m.app_register_card_no_owner_agent()
            : m.app_register_card_secret_sent()}
        </p>
      )}
    </div>
  );
}
