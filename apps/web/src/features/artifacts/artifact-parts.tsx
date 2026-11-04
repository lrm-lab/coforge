import { Browser, File02 } from "@untitledui/icons";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
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

/** What an artifact is, from its card's `kind`: a web page (`html`), else a document. */
export const isWebPage = (kind: string) => kind === "html";

/** The artifact's kind in words, as its card and its row say it beside the title. */
export const kindLabel = (kind: string) =>
  isWebPage(kind) ? m.doc_kind_html() : m.doc_kind_markdown();

/** An artifact's kind as a gray tile, as its card, its row and its page lead with it: gray, so
 * the content keeps the color (Frank, 11-04). */
export function ArtifactIcon({ kind, size = "md" }: { kind: string; size?: "sm" | "md" }) {
  const Icon = isWebPage(kind) ? Browser : File02;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-secondary text-fg-tertiary ring-1 ring-secondary ring-inset",
        size === "md" ? "size-9" : "size-7",
      )}
    >
      <Icon className={size === "md" ? "size-5" : "size-4"} />
    </span>
  );
}

/** The version and who changed it last, when: the line under an artifact's title. */
export function ArtifactEditedLine({
  version,
  actor,
  time,
}: {
  version: number;
  actor: ArtifactActorView | undefined;
  time: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
      <span className="shrink-0">{versionLabel(version)}</span>
      <span aria-hidden="true">·</span>
      <ArtifactActor actor={actor} />
      <span className="shrink-0">{time}</span>
    </span>
  );
}

/** Who did it, as a small face and a name; the viewer reads as "You". */
export function ArtifactActor({ actor }: { actor: ArtifactActorView | undefined }) {
  if (!actor) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ActorAvatar
        presence={false}
        size="xs"
        src={actor.avatarUrl}
        name={actor.name}
        className="size-4"
      />
      <span className="truncate">{actor.viewer ? m.conversation_you() : actor.name}</span>
    </span>
  );
}

/** A publisher's name in a sentence ("X published version N"): the viewer's own is "You". */
export const actorName = (actor: ArtifactActorView | undefined) =>
  actor ? (actor.viewer ? m.conversation_you() : actor.name) : m.doc_someone();

/** A new document's pane beside the conversation until its first save; in full screen, the whole
 * page; on a phone, over it. */
export function PaneFrame({ full, children }: { full?: boolean; children: React.ReactNode }) {
  return (
    <section
      aria-label={m.doc_pane_label()}
      className={cn(
        "@container/doc flex min-h-0 flex-col bg-primary max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-auto",
        full ? "min-w-0 flex-1" : "w-[min(48rem,56%)] shrink-0 border-l border-secondary",
      )}
    >
      {children}
    </section>
  );
}
