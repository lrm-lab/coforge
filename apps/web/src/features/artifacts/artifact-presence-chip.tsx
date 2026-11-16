import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import { cn } from "#src/lib/utils";
import { useArtifactTime } from "./artifact-parts";
import { artifactViewersQuery } from "./artifact-queries";
import { keepArtifactViewing } from "./artifact-viewer.functions";

const HEARTBEAT_MS = 20_000;

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

export function ArtifactPresenceChip({ artifactId }: { artifactId: string }) {
  const time = useArtifactTime();
  const { data } = useQuery({
    ...artifactViewersQuery(artifactId),
    refetchInterval: HEARTBEAT_MS,
  });
  if (!data) return null;
  const now = new Set(data.viewingNow.map((person) => person.userId));
  const viewing = Math.max(now.size, 1);
  const others = data.seen.filter((person) => !now.has(person.userId));
  const nameOf = (person: { userId: string; name: string }) =>
    person.userId === data.you ? m.av_presence_you() : person.name;
  return (
    <DialogTrigger>
      <AriaButton
        aria-label={m.av_presence_label()}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
      >
        <span className="flex -space-x-1.5">
          {data.viewingNow.slice(0, 3).map((person) => (
            <ActorAvatar
              key={person.userId}
              presence={false}
              userId={person.userId}
              name={person.name}
              size="xs"
              className="size-5 ring-2 ring-primary"
            />
          ))}
        </span>
        <span className="max-sm:sr-only">{m.av_viewing_count({ count: viewing })}</span>
      </AriaButton>
      <Popover
        placement="bottom end"
        className={cn(
          "w-64 origin-(--trigger-anchor-point) rounded-lg bg-primary shadow-lg ring-1 ring-secondary_alt",
          POPOVER_MOTION,
        )}
      >
        <Dialog aria-label={m.av_presence_label()} className="p-2 outline-hidden">
          <ul className="flex flex-col">
            {data.viewingNow.map((person) => (
              <PresenceRow key={person.userId} name={nameOf(person)} detail={m.av_presence_now()} />
            ))}
            {others.map((person) => (
              <PresenceRow
                key={person.userId}
                name={nameOf(person)}
                detail={
                  person.seenVersion < data.currentVersion
                    ? `${time(person.openedAt)} · ${m.av_presence_saw({ version: person.seenVersion })}`
                    : time(person.openedAt)
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

function PresenceRow({ name, detail }: { name: string; detail: string }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm">
      <span className="min-w-0 truncate font-medium text-secondary">{name}</span>
      <span className="shrink-0 text-xs text-tertiary">{detail}</span>
    </li>
  );
}
