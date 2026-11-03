import { File02 } from "@untitledui/icons";

import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { lastMessageTime } from "#src/features/conversations/last-message-time";
import { useStartOfToday } from "#src/lib/start-of-today";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { ArtifactActorView } from "./artifact-queries";

/** When a document changed, as a chat row reads it: today's clock time, else the day. */
export function useArtifactTime() {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const today = useStartOfToday(timeZone);
  return (at: string | Date) =>
    lastMessageTime(typeof at === "string" ? at : at.toISOString(), {
      now: new Date(today),
      locale: getLocale(),
      timeZone,
      timeFormat,
    });
}

/** "Version N", or "Not saved yet" for a document with no version. */
export const versionLabel = (number: number) =>
  number > 0 ? m.doc_version({ number: String(number) }) : m.doc_version_none();

/** A document's icon tile, as its card and its list row lead with it. */
export function ArtifactIcon({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-brand-secondary text-featured-icon-light-fg-brand",
        size === "md" ? "size-10" : "size-8",
      )}
    >
      <File02 className={size === "md" ? "size-5" : "size-4"} />
    </span>
  );
}

/** Who did it, as a small face and a name; the viewer reads as "You". */
export function ArtifactActor({ actor }: { actor: ArtifactActorView | undefined }) {
  if (!actor) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <IdentityAvatar size="xs" src={actor.avatarUrl} name={actor.name} className="size-4" />
      <span className="truncate">{actor.viewer ? m.conversation_you() : actor.name}</span>
    </span>
  );
}

/** A publisher's name in a sentence ("X published version N"): the viewer's own is "You". */
export const actorName = (actor: ArtifactActorView | undefined) =>
  actor ? (actor.viewer ? m.conversation_you() : actor.name) : m.doc_someone();
