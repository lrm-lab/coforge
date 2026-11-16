import { ChannelPlace } from "#src/features/conversations/channel-name";
import { useEffect, useState } from "react";
import { AlarmClock, Repeat01 as Repeat } from "@untitledui/icons";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { Link } from "@tanstack/react-router";
import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatRecurrence } from "./agent-reminder-repeat";
import { AgentTabEmpty } from "./profile-panel/agent-tab-empty";
import type { AgentReminderListItem } from "#src/server/agents/agent-reminders.server";

type ListResult = Awaited<
  ReturnType<typeof import("./agent-reminders.functions").listAgentReminders>
>;
export function AgentReminders({
  agentId,
  canRead,
  timeZone,
  onLoad,
}: {
  agentId: string;
  /** The viewer created the Agent or is a Workspace owner/admin (`canManageAgent`). */
  canRead: boolean;
  timeZone: string | null;
  onLoad: (cursor?: { id: string }) => Promise<ListResult>;
}) {
  const [result, setResult] = useState<ListResult>();
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let active = true;
    setResult(undefined);
    setError(false);
    void onLoad()
      .then((value) => active && setResult(value))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [agentId, onLoad, canRead]);

  if (!canRead || result?.status === "unauthorized")
    return <State message={m.agent_reminders_private()} />;
  if (error)
    return (
      <State
        message={m.agent_reminders_error()}
        alert
        action={
          <Button
            size="sm"
            color="secondary"
            onPress={() => {
              setError(false);
              setResult(undefined);
              void onLoad()
                .then(setResult)
                .catch(() => setError(true));
            }}
          >
            {m.agent_reminders_retry()}
          </Button>
        }
      />
    );
  if (!result)
    return (
      <div
        className="mt-3 animate-pulse divide-y divide-secondary"
        aria-label={m.agent_reminders_loading()}
      >
        {["w-52", "w-64", "w-44"].map((width) => (
          <div key={width} className="space-y-2 py-3">
            <div className={`h-4 ${width} max-w-2/3 rounded bg-secondary`} />
            <div className="h-3 w-32 rounded bg-secondary" />
          </div>
        ))}
      </div>
    );
  if (!result.reminders.length)
    return (
      <AgentTabEmpty
        icon={AlarmClock}
        title={m.agent_reminders_empty()}
        description={m.agent_reminders_empty_description()}
      />
    );

  return (
    <div className="mt-3 space-y-3">
      <ol className="divide-y divide-secondary">
        {result.reminders.map((reminder) => (
          <ReminderRow key={reminder.id} reminder={reminder} timeZone={timeZone} />
        ))}
      </ol>
      {result.hasMore && result.cursor && (
        <Button
          color="secondary"
          isDisabled={loadingMore}
          onPress={async () => {
            setLoadingMore(true);
            try {
              const next = await onLoad(result.cursor ?? undefined);
              if (next.status === "ready")
                setResult({ ...next, reminders: [...result.reminders, ...next.reminders] });
            } catch {
              setError(true);
            } finally {
              setLoadingMore(false);
            }
          }}
        >
          {loadingMore ? m.agent_reminders_loading() : m.agent_reminders_load_more()}
        </Button>
      )}
    </div>
  );
}

function ReminderRow({
  reminder,
  timeZone,
}: {
  reminder: AgentReminderListItem;
  timeZone: string | null;
}) {
  return (
    <li className="min-w-0 py-3" data-reminder-row="">
      <p className="line-clamp-2 text-sm font-medium whitespace-pre-wrap wrap-anywhere text-primary">
        {reminder.title}
      </p>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tertiary">
        <RelativeTime value={reminder.fireAt} timeZone={reminder.timezone ?? timeZone} showExact />
        {reminder.repeat && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Repeat className="size-3.5 shrink-0" aria-hidden="true" />
            {formatRecurrence(reminder.repeat)}
          </span>
        )}
        {reminder.anchor && <Place anchor={reminder.anchor} />}
      </div>
    </li>
  );
}

/** Where the reminder fires: a channel by its group avatar and name, a direct conversation by the
 * person's face and name, never a raw target or id (task #126). A place the viewer cannot open
 * shows nothing. */
function Place({ anchor }: { anchor: NonNullable<AgentReminderListItem["anchor"]> }) {
  const label =
    anchor.kind === "channel" ? (
      <ChannelPlace
        id={anchor.channelId}
        name={anchor.channelName}
        visibility={anchor.visibility}
        members={anchor.members}
      />
    ) : anchor.person ? (
      <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-bottom">
        <ActorAvatar
          presence={false}
          size="xs"
          className="size-5"
          src={anchor.person.avatarUrl}
          name={anchor.person.name}
          alt=""
        />
        <span className="min-w-0 truncate">{anchor.person.name}</span>
      </span>
    ) : null;
  if (!label) return null;
  return (
    <AnchorLink
      anchor={anchor}
      className="inline-flex max-w-full min-w-0 rounded-sm outline-none hover:text-secondary hover:underline focus-visible:ring-2 focus-visible:ring-brand"
    >
      {label}
    </AnchorLink>
  );
}

function AnchorLink({
  anchor,
  children,
  className,
}: {
  anchor: NonNullable<AgentReminderListItem["anchor"]>;
  children: React.ReactNode;
  className: string;
}) {
  const workspaceSlug = useWorkspaceSlug();
  return anchor.kind === "channel" ? (
    <Link
      className={className}
      to="/w/$workspaceSlug/channel/$channelId"
      params={{ workspaceSlug, channelId: anchor.channelId }}
      search={{
        view: "chat",
        message: anchor.messageId,
        threadRootId: anchor.threadRootId ?? undefined,
      }}
      hash={`message-${anchor.messageId}`}
    >
      {children}
    </Link>
  ) : (
    <Link
      className={className}
      to="/w/$workspaceSlug/dm/$dmId"
      params={{ workspaceSlug, dmId: anchor.conversationId }}
      search={{
        view: "chat",
        message: anchor.messageId,
        threadRootId: anchor.threadRootId ?? undefined,
      }}
      hash={`message-${anchor.messageId}`}
    >
      {children}
    </Link>
  );
}

function State({
  message,
  alert = false,
  action,
}: {
  message: string;
  alert?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="mt-6 flex min-h-10 items-center gap-3 text-sm text-tertiary"
      role={alert ? "alert" : undefined}
    >
      <p>{message}</p>
      {action}
    </div>
  );
}
