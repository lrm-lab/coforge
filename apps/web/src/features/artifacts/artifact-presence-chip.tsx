import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Focusable,
  Popover,
} from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { RelativeTime } from "#src/components/ui/relative-time";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorAvatarStack } from "#src/features/avatars/actor-avatar-stack";
import { AVATAR_STACK_RING } from "#src/features/avatars/avatar-stack-ring";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import { FLOATING_SURFACE_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { useChannelPresence, usePresentUsers } from "#src/features/realtime/channel-presence";
import { ARTIFACT_ROSTER_SIZE, artifactPresenceChannel } from "./artifact-presence-channel";
import { presenceSummary } from "./artifact-presence-summary";
import { artifactViewersQuery, type ArtifactViewers } from "./artifact-queries";
import { loadArtifactViewers, markArtifactSeen, openArtifact } from "./artifact-viewer.functions";

const SEEN_GAP_MS = 3_000;
const STACK_FACES = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useKeepSeen(artifactId: string) {
  const state = useRef({
    running: false,
    queued: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  useEffect(() => {
    const current = state.current;
    return () => {
      clearTimeout(current.timer);
      current.running = false;
      current.queued = false;
    };
  }, [artifactId]);
  return useCallback(() => {
    const current = state.current;
    if (document.visibilityState !== "visible") return;
    if (current.running) {
      current.queued = true;
      return;
    }
    const run = () => {
      current.running = true;
      void markArtifactSeen({ data: { artifactId } })
        .catch(() => undefined)
        .finally(() => {
          current.timer = setTimeout(() => {
            current.running = false;
            if (!current.queued) return;
            current.queued = false;
            run();
          }, SEEN_GAP_MS);
        });
    };
    run();
  }, [artifactId]);
}

export function useRecordOpen(artifactId: string, version: number): boolean {
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (version <= 0) return;
    let current = true;
    void openArtifact({ data: { artifactId, version } })
      .then((roster) => {
        queryClient.setQueryData(artifactViewersQuery(artifactId).queryKey, roster);
        if (current) setOpened(true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [artifactId, version, queryClient]);
  return opened;
}

export function useNameNewViewers(
  artifactId: string,
  roster: ArtifactViewers | undefined,
  present: ReadonlySet<string> | undefined,
) {
  const queryClient = useQueryClient();
  const named = new Set(roster?.seen.map((person) => person.userId));
  const viewing = present
    ? [...present]
        .filter((userId) => UUID.test(userId))
        .sort((a, b) => Number(b === roster?.you) - Number(a === roster?.you) || a.localeCompare(b))
        .slice(0, ARTIFACT_ROSTER_SIZE)
    : [];
  const unnamed = roster ? viewing.filter((userId) => !named.has(userId)).join(" ") : "";
  const viewingKey = viewing.join(" ");
  useEffect(() => {
    if (!unnamed) return;
    void loadArtifactViewers({ data: { artifactId, viewing: viewingKey.split(" ") } })
      .then((fresh) => queryClient.setQueryData(artifactViewersQuery(artifactId).queryKey, fresh))
      .catch(() => undefined);
  }, [artifactId, unnamed, viewingKey, queryClient]);
}

export function shapeRoster(roster: ArtifactViewers, viewing: ReadonlySet<string>) {
  const viewingNow = roster.seen
    .filter((person) => viewing.has(person.userId))
    .sort((a, b) => Number(b.userId === roster.you) - Number(a.userId === roster.you));
  return {
    ...roster,
    viewingNow,
    others: roster.seen.filter((person) => !viewing.has(person.userId)),
  };
}

export function ArtifactPresenceChip({
  workspaceId,
  artifactId,
  ready,
}: {
  workspaceId: string | undefined;
  artifactId: string;
  ready: boolean;
}) {
  const present = usePresentUsers(
    useChannelPresence(
      ready && workspaceId ? artifactPresenceChannel(workspaceId, artifactId) : undefined,
    ),
  );
  const { data: roster } = useQuery({ ...artifactViewersQuery(artifactId), enabled: ready });
  useNameNewViewers(artifactId, roster, present);
  const data = roster && shapeRoster(roster, present ?? new Set([roster.you]));
  if (!data) return null;
  const me = data.viewingNow.find((person) => person.userId === data.you);
  const othersViewing = data.viewingNow.filter((person) => person.userId !== data.you);
  const shown = othersViewing.slice(0, me ? STACK_FACES - 1 : STACK_FACES);
  const othersCount = present ? present.size - (present.has(data.you) ? 1 : 0) : 0;
  const summary = presenceSummary({
    othersViewing: othersCount,
    youViewing: present?.has(data.you) ?? true,
    seenLatest: data.seenLatest,
  }).map((part) =>
    part.kind === "viewing"
      ? m.av_presence_summary_viewing({ count: part.count })
      : part.kind === "you"
        ? m.av_presence_summary_you()
        : m.av_presence_summary_saw_latest({ count: part.count }),
  );
  const nameOf = (person: { userId: string; name: string }) =>
    person.userId === data.you ? m.av_presence_you() : person.name;
  return (
    <DialogTrigger>
      <AriaButton
        aria-label={m.av_presence_label()}
        className="flex h-8 shrink-0 items-center rounded-lg px-1.5 outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2"
      >
        <ActorAvatarStack more={Math.max(0, othersCount - shown.length)}>
          {[...shown, ...(me ? [me] : [])].map((person) => (
            <span
              key={person.userId}
              data-viewer={person.userId}
              className="flex animate-in fade-in motion-enter-sm"
            >
              <PersonFace person={person} className={cn("size-5", AVATAR_STACK_RING.regular)} />
              <span className="sr-only">{nameOf(person)}</span>
            </span>
          ))}
        </ActorAvatarStack>
      </AriaButton>
      <Popover
        placement="bottom start"
        className={cn(
          "flex w-64 origin-(--trigger-anchor-point) flex-col",
          FLOATING_SURFACE_CLASS,
          POPOVER_MOTION,
        )}
      >
        <Dialog
          aria-label={m.av_presence_label()}
          className="flex min-h-0 flex-col p-2 outline-hidden"
        >
          {summary.length > 0 && (
            <p className="px-2 pt-1 pb-2 text-xs text-tertiary">
              {summary.map((part, index) => (
                <Fragment key={part}>
                  {index > 0 && ", "}
                  <span className="whitespace-nowrap">{part}</span>
                </Fragment>
              ))}
            </p>
          )}
          <ul className="min-h-0 overflow-y-auto">
            {data.viewingNow.map((person) => (
              <PresenceRow
                key={person.userId}
                person={person}
                name={nameOf(person)}
                detail={m.av_presence_now()}
              />
            ))}
            {data.others.map((person) => (
              <PresenceRow
                key={person.userId}
                person={person}
                name={nameOf(person)}
                detail={
                  <>
                    <RelativeTime value={person.openedAt} plain />
                    {person.seenVersion < data.currentVersion &&
                      `, ${m.av_presence_saw({ version: person.seenVersion })}`}
                  </>
                }
              />
            ))}
          </ul>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function PresenceRow({
  person,
  name,
  detail,
}: {
  person: { userId: string; name: string; avatarUrl: string | null };
  name: string;
  detail: ReactNode;
}) {
  return (
    <li className="flex h-8 items-center gap-2 rounded-md px-2 text-sm">
      <PersonFace person={person} />
      <Tooltip title={name} placement="top start">
        <Focusable>
          <span
            tabIndex={0}
            className="min-w-0 flex-1 cursor-default truncate rounded-sm text-left font-medium text-secondary outline-focus-ring focus-visible:outline-2"
          >
            {name}
          </span>
        </Focusable>
      </Tooltip>
      <span className="shrink-0 text-xs text-tertiary">{detail}</span>
    </li>
  );
}

function PersonFace({
  person,
  className,
}: {
  person: { userId: string; name: string; avatarUrl: string | null };
  className?: string;
}) {
  return (
    <ActorAvatar
      presence={false}
      userId={person.userId}
      src={person.avatarUrl ?? undefined}
      name={person.name}
      size="xs"
      className={className}
    />
  );
}
