import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";

import { RelativeTime } from "#src/components/ui/relative-time";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorAvatarStack, AVATAR_STACK_RING } from "#src/features/avatars/actor-avatar-stack";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import { cn } from "#src/lib/utils";
import { artifactViewersQuery, type ArtifactViewers } from "./artifact-queries";
import { keepArtifactViewing, openArtifact } from "./artifact-viewer.functions";

const HEARTBEAT_MS = 20_000;

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

export function useKeepViewing(artifactId: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void keepArtifactViewing({ data: { artifactId } }).catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [artifactId, active]);
}

function shapeRoster(roster: ArtifactViewers) {
  const viewingNow = [...roster.viewingNow].sort(
    (a, b) => Number(b.userId === roster.you) - Number(a.userId === roster.you),
  );
  const now = new Set(viewingNow.map((person) => person.userId));
  return {
    ...roster,
    viewingNow,
    others: roster.seen.filter((person) => !now.has(person.userId)),
  };
}

export function ArtifactPresenceChip({
  artifactId,
  ready,
}: {
  artifactId: string;
  ready: boolean;
}) {
  const { data } = useQuery({
    ...artifactViewersQuery(artifactId),
    enabled: ready,
    staleTime: HEARTBEAT_MS,
    refetchInterval: HEARTBEAT_MS,
    select: shapeRoster,
  });
  if (!data || (data.viewingNow.length === 0 && data.others.length === 0)) return null;
  const faces = (data.viewingNow.length > 0 ? data.viewingNow : data.others).slice(0, 3);
  const nameOf = (person: { userId: string; name: string }) =>
    person.userId === data.you ? m.av_presence_you() : person.name;
  return (
    <DialogTrigger>
      <AriaButton
        aria-label={m.av_presence_label()}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
      >
        <ActorAvatarStack>
          {faces.map((person) => (
            <ActorAvatar
              key={person.userId}
              presence={false}
              userId={person.userId}
              name={person.name}
              size="xs"
              className={cn("size-5", AVATAR_STACK_RING.regular)}
            />
          ))}
        </ActorAvatarStack>
        {data.viewingNow.length > 0 && (
          <span className="max-sm:sr-only">
            {m.av_viewing_count({ count: data.viewingNow.length })}
          </span>
        )}
      </AriaButton>
      <Popover
        placement="bottom start"
        className={cn(
          "w-64 origin-(--trigger-anchor-point) rounded-lg bg-primary shadow-lg ring-1 ring-secondary_alt",
          POPOVER_MOTION,
        )}
      >
        <Dialog aria-label={m.av_presence_label()} className="p-2 outline-hidden">
          <ul className="flex flex-col">
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
                      ` · ${m.av_presence_saw({ version: person.seenVersion })}`}
                  </>
                }
              />
            ))}
          </ul>
          {data.behind > 0 && (
            <p className="mt-1 border-t border-secondary px-2 pt-2 text-xs text-tertiary">
              {m.av_presence_behind({ count: data.behind, version: data.currentVersion })}
            </p>
          )}
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
  person: { userId: string; name: string };
  name: string;
  detail: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
      <ActorAvatar presence={false} userId={person.userId} name={person.name} size="xs" />
      <span className="min-w-0 flex-1 truncate font-medium text-secondary">{name}</span>
      <span className="shrink-0 text-xs text-tertiary">{detail}</span>
    </li>
  );
}
