import type { ReactNode, Ref } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Clock, Grid01, SlashCircle01 } from "@untitledui/icons";

import { ActorName } from "#src/features/avatars/actor-name";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { ActionCardActor } from "#src/server/conversations/action-card-view.server";
import { m } from "#src/paraglide/messages";
import { messageSlots } from "#src/lib/message-slots";
import { cn } from "#src/lib/utils";
import { AnsweredAtTooltip, type FocusableLink } from "./action-card-answered-at";
import {
  actionCardHandledVerb,
  addMemberChannelName,
  unhandledKind,
  type ToolActionCardView,
} from "./action-card-labels";
import { NamesWithFaces } from "./action-card-object";
import { ActionCardFrame } from "./action-card-pending";
import { feedbackCategoryLabel } from "./action-card-feedback";
import { cardActor } from "./action-card-actor";
import { ChannelPlace } from "./channel-name";

type Target = { kind: "channel"; channelId: string } | { kind: "agent"; agentId: string };

type Outcome = { text: ReactNode; quiet?: boolean };

function AppName({ name }: { name: string }) {
  return (
    <span>
      <Grid01
        aria-hidden="true"
        className="mr-1 inline-block size-4 align-text-bottom text-fg-quaternary"
      />
      {name}
    </span>
  );
}

function asCommitted(view: ToolActionCardView): ToolActionCardView {
  if (view.kind !== "channel:add_member" || !view.result) return view;
  const kept = new Set([...view.result.userIds, ...view.result.agentIds]);
  return {
    ...view,
    humans: view.humans.filter((person) => kept.has(person.id)),
    agents: view.agents.filter((person) => kept.has(person.id)),
  };
}

function AppRegisterNotice({ view, className }: { view: ToolActionCardView; className?: string }) {
  if (view.kind !== "app:register" || !view.result) return null;
  return (
    <p className={cn("text-xs text-tertiary", className)}>
      {view.result.noOwnerAgent
        ? m.app_register_card_no_owner_agent()
        : view.result.secretUndelivered
          ? m.app_register_card_secret_undelivered()
          : m.app_register_card_secret_sent()}
    </p>
  );
}

function outcomeOf(view: ToolActionCardView): Outcome | undefined {
  switch (view.kind) {
    case "channel:create":
      return {
        text: view.result ? (
          <ChannelPlace id={view.result.channelId} name={view.name} visibility={view.visibility} />
        ) : (
          view.name
        ),
      };
    case "agent:create":
      return {
        text: view.result ? (
          <ActorName inline actor={{ kind: "agent", id: view.result.agentId, name: view.name }} />
        ) : (
          view.name
        ),
      };
    case "channel:add_member": {
      const people = [
        ...view.humans.map((person) => ({ ...person, kind: "user" as const })),
        ...view.agents.map((person) => ({ ...person, kind: "agent" as const })),
      ];
      const channel =
        view.result && view.channel.id ? (
          <ChannelPlace id={view.channel.id} name={view.channel.displayName} />
        ) : (
          addMemberChannelName(view.channel)
        );
      return {
        text: people.length ? (
          <>
            <NamesWithFaces people={people} /> → {channel}
          </>
        ) : (
          channel
        ),
      };
    }
    case "page:fill":
    case "desktop:takeover":
      return view.prompt ? { text: view.prompt, quiet: true } : undefined;
    case "feedback:submit":
      return {
        text: feedbackCategoryLabel(view.result?.category ?? view.category),
        quiet: true,
      };
    case "app:grant_agent":
      return { text: <AppName name={view.app.name} /> };
    case "app:register":
      return {
        text: (
          <>
            <AppName name={view.app.name} />
            {view.result && <span className="ml-1.5 text-quaternary">{view.result.clientKey}</span>}
          </>
        ),
      };
    case "app:recover_owner":
      return {
        text: view.result ? (
          <>
            {view.result.ownerAgent} → <AppName name={view.app.name} />
          </>
        ) : (
          <AppName name={view.app.name} />
        ),
      };
    default:
      return unhandledKind(view);
  }
}

function targetOf(view: ToolActionCardView): Target | undefined {
  if (view.kind === "channel:create" && view.result)
    return { kind: "channel", channelId: view.result.channelId };
  if (view.kind === "agent:create" && view.result)
    return { kind: "agent", agentId: view.result.agentId };
  if (view.kind === "channel:add_member" && view.result && view.channel.id)
    return { kind: "channel", channelId: view.channel.id };
  return undefined;
}

function targetLink(
  workspaceSlug: string,
  target: Target,
  text: ReactNode,
  className: string,
): FocusableLink {
  return target.kind === "channel" ? (
    <Link
      to="/w/$workspaceSlug/channel/$channelId"
      params={{ workspaceSlug, channelId: target.channelId }}
      className={className}
    >
      {text}
    </Link>
  ) : (
    <Link
      to="/w/$workspaceSlug/members"
      params={{ workspaceSlug }}
      search={{ profile: formatAgentProfileParam(target.agentId), agentTab: "profile" }}
      className={className}
    >
      {text}
    </Link>
  );
}

const THING_LINK_CLASS =
  "rounded-sm font-medium text-primary outline-focus-ring underline-offset-2 hover:underline focus-visible:outline-2 [@media(hover:hover)]:[&:hover_[data-channel-name]]:underline";

const OPEN_LINK_CLASS =
  "ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm font-semibold text-brand-secondary outline-focus-ring underline-offset-2 hover:underline focus-visible:outline-2";

function isClosed(view: ToolActionCardView) {
  return view.state === "cancelled" || view.state === "expired";
}

function HandledMark({ view }: { view: ToolActionCardView }) {
  const closed = isClosed(view);
  const Mark = view.state === "expired" ? Clock : closed ? SlashCircle01 : Check;
  return (
    <Mark
      aria-hidden="true"
      className={cn(
        "my-0.5 size-4 shrink-0",
        closed ? "text-fg-quaternary" : "text-fg-success-primary",
      )}
    />
  );
}

function closedWord(view: ToolActionCardView) {
  if (view.state === "expired") return m.action_card_expired();
  return view.kind === "app:grant_agent" ? m.app_card_denied() : m.action_card_cancelled();
}

function HandledBy({ by, className }: { by: ActionCardActor; className?: string }) {
  return (
    <span className={cn("text-quaternary", className)}>
      {messageSlots(m.action_card_handled_by, {
        name: <ActorName actor={cardActor(by)} inline />,
      })}
    </span>
  );
}

function othersCommit(view: ToolActionCardView) {
  return view.committedBy && !view.committedBy.isViewer ? view.committedBy : undefined;
}

function Timed({
  at,
  by,
  children,
}: {
  at: string | undefined;
  by?: ActionCardActor;
  children: ReactNode;
}) {
  return at ? (
    <AnsweredAtTooltip at={at} by={by}>
      {children}
    </AnsweredAtTooltip>
  ) : (
    children
  );
}

export function HandledActionCard({ view: shown }: { view: ToolActionCardView }) {
  const view = asCommitted(shown);
  const workspaceSlug = useWorkspaceSlug();
  const closed = isClosed(view);
  const outcome = outcomeOf(view);
  const target = targetOf(view);
  const at = view.committedAt;
  const by = othersCommit(view);
  const link =
    outcome && target && targetLink(workspaceSlug, target, outcome.text, THING_LINK_CLASS);
  const words = outcome && !link && (
    <span className={closed || outcome.quiet ? "text-secondary" : "font-medium text-primary"}>
      {outcome.text}
    </span>
  );
  const thing = link && at ? <AnsweredAtTooltip at={at} link={link} /> : (link ?? words);
  const verb = actionCardHandledVerb(view);
  return (
    <div className="text-sm wrap-anywhere text-tertiary">
      <p className="flex items-start gap-1.5">
        <HandledMark view={view} />
        <span className="min-w-0">
          {!closed && !link ? <Timed at={at}>{verb}</Timed> : verb} {thing}
          {closed && (
            <>
              {" "}
              <Timed at={at}>
                <span className="text-quaternary">{closedWord(view)}</span>
              </Timed>
            </>
          )}
          {by && (
            <>
              {" "}
              <HandledBy by={by} />
            </>
          )}
        </span>
      </p>
      <AppRegisterNotice view={view} className="pt-1 pl-5.5" />
    </div>
  );
}

export function SettledActionCard({
  frameRef,
  view: shown,
  minHeight,
}: {
  frameRef: Ref<HTMLDivElement>;
  view: ToolActionCardView;
  minHeight: number | undefined;
}) {
  const view = asCommitted(shown);
  const workspaceSlug = useWorkspaceSlug();
  const closed = isClosed(view);
  const target = targetOf(view);
  const by = othersCommit(view);
  return (
    <ActionCardFrame ref={frameRef} view={view} minHeight={minHeight}>
      <div className="mt-auto flex flex-col gap-3">
        <AppRegisterNotice view={view} />
        <div
          data-action-card-handled=""
          className="flex min-h-9 min-w-0 items-center gap-1.5 text-sm text-tertiary max-sm:min-h-11"
        >
          <HandledMark view={view} />
          <Timed at={view.committedAt} by={by}>
            <span className={cn("shrink-0", closed && "text-quaternary")}>
              {closed ? closedWord(view) : actionCardHandledVerb(view)}
            </span>
          </Timed>
          {by && <HandledBy by={by} className="min-w-0 flex-1 truncate" />}
          {target &&
            targetLink(
              workspaceSlug,
              target,
              <>
                {m.action_card_open()}
                <ArrowRight aria-hidden="true" className="size-4" />
              </>,
              OPEN_LINK_CLASS,
            )}
        </div>
      </div>
    </ActionCardFrame>
  );
}
