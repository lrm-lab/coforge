import { useQuery } from "@tanstack/react-query";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { Link, Navigate } from "@tanstack/react-router";
import { Edit01, Edit03 } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { overviewTaskQuery } from "#src/features/tasks/use-finished-tasks";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { channelGlyph } from "./channel-name";
import { channelLabel } from "./channel-visibility";
import { draftRoute, type DraftRow } from "./drafts-model";
import { useDraftRows } from "./use-drafts";
import { useDraftsOn } from "./use-drafts-on";

/**
 * The Drafts view: every message typed and not sent in a conversation of this Workspace, newest
 * edit first. A row goes back to the place the text was written, whose composer still holds it
 * (see `drafts.md`). Nothing here deletes a draft: sending or emptying the composer does. It is
 * the Drafts experiment's page: with the experiment off, Chat opens instead, and nothing shows
 * until that is known.
 */
export function DraftsView() {
  const on = useDraftsOn();
  const workspaceSlug = useWorkspaceSlug();
  if (on === undefined) return null;
  if (!on) return <Navigate to="/w/$workspaceSlug" params={{ workspaceSlug }} replace />;
  return <DraftsList />;
}

function DraftsList() {
  const rows = useDraftRows();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        heading={m.conversation_drafts_nav()}
        meta={
          rows.length > 0 && (
            <span className="shrink-0 text-sm text-tertiary">
              {m.conversation_drafts_count({ count: rows.length })}
            </span>
          )
        }
      />
      {rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Edit03 aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{m.conversation_drafts_empty_title()}</EmptyTitle>
              <EmptyDescription>{m.conversation_drafts_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {rows.map((row) => (
            <DraftListItem key={row.key} row={row} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** What the draft's place is called: a Task by its own title, a thread by its channel or DM. */
function DraftTitle({ row }: { row: DraftRow }) {
  const { target } = row;
  if (target.kind === "task")
    return <TaskDraftTitle conversationId={row.conversationId} number={target.number} />;
  const place = homeLabel(row);
  return target.kind === "thread" ? m.conversation_drafts_thread_in({ place }) : place;
}

/** The Task's title, read on its own; its number until that is known or if the viewer cannot see it. */
function TaskDraftTitle({ conversationId, number }: { conversationId: string; number: number }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const task = useQuery(overviewTaskQuery(workspaceId, { conversationId, number }));
  return task.data?.title || m.tasks_details_title({ number });
}

/** The channel as text, or the DM's peer. */
function homeLabel({ home }: DraftRow): string {
  return home.kind === "channel" ? channelLabel(home.channel) : home.direct.name;
}

function DraftListItem({ row }: { row: DraftRow }) {
  const workspaceSlug = useWorkspaceSlug();
  const { target } = row;
  return (
    <li>
      <Link
        {...draftRoute(row, workspaceSlug)}
        className="flex items-start gap-3 rounded-xl border border-secondary bg-primary p-3 outline-focus-ring transition-colors select-none hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <DraftFace row={row} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
              <DraftTitle row={row} />
            </span>
            {row.updatedAt !== null && (
              <RelativeTime
                plain
                value={new Date(row.updatedAt)}
                className="shrink-0 text-xs text-tertiary"
              />
            )}
          </span>
          <span className="flex items-start gap-1.5 text-sm text-secondary">
            <Edit01
              role="img"
              aria-hidden={false}
              aria-label={m.conversation_drafts_draft_marker()}
              className="mt-0.5 size-3.5 shrink-0 text-quaternary"
            />
            <span className="line-clamp-2 min-w-0 break-words">
              {target.kind === "task" && (
                <span className="text-tertiary">
                  {homeLabel(row)} · #{target.number}{" "}
                </span>
              )}
              {row.body}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

/** The place's face: a person's or Agent's avatar for a DM, the channel's `#` or lock otherwise. */
function DraftFace({ row }: { row: DraftRow }) {
  const { home } = row;
  if (home.kind === "dm") {
    const { name, peer } = home.direct;
    return peer.kind === "people" ? (
      <ActorAvatar presence size="sm" userId={peer.userId} name={name} src={peer.avatarUrl} />
    ) : (
      <ActorAvatar size="sm" presence agentId={peer.agentId} name={name} src={peer.avatarUrl} />
    );
  }
  const Glyph = channelGlyph(home.channel);
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary">
      <Glyph aria-hidden="true" className="size-4 text-tertiary" />
    </span>
  );
}
