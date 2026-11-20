import {
  Browser,
  File02,
  File04,
  FileCode01,
  Image01,
  Table,
  VideoRecorder,
} from "@untitledui/icons";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { lastMessageTime } from "#src/features/conversations/last-message-time";
import { useStartOfToday } from "#src/lib/start-of-today";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { artifactKindOfPath, type ArtifactPathKind } from "./artifact-path-kind";
import type { ArtifactActorView } from "./artifact-queries";

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

const KIND_LABELS: Record<ArtifactPathKind, () => string> = {
  html: m.doc_kind_html,
  markdown: m.doc_kind_markdown,
  text: m.doc_kind_text,
  csv: m.doc_kind_csv,
  image: m.doc_kind_image,
  pdf: m.doc_kind_pdf,
  video: m.doc_kind_video,
  other: m.doc_kind_other,
};

export const kindName = (kind: ArtifactPathKind) => KIND_LABELS[kind]();

export const kindLabel = (entryPath: string) => kindName(artifactKindOfPath(entryPath));

const KIND_ICONS = {
  html: Browser,
  markdown: File02,
  text: FileCode01,
  csv: Table,
  image: Image01,
  pdf: File04,
  video: VideoRecorder,
  other: File04,
} satisfies Record<ArtifactPathKind, unknown>;

export function ArtifactIcon({
  entryPath,
  size = "md",
}: {
  entryPath: string;
  size?: "sm" | "md";
}) {
  const kind = artifactKindOfPath(entryPath);
  const Icon = KIND_ICONS[kind];
  return (
    <span
      aria-hidden="true"
      data-artifact-kind={kind}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-secondary text-fg-tertiary ring-1 ring-secondary ring-inset",
        size === "md" ? "size-9" : "size-7",
      )}
    >
      <Icon className={size === "md" ? "size-5" : "size-4"} />
    </span>
  );
}

export function ArtifactEditedLine({
  actor,
  time,
}: {
  actor: ArtifactActorView | undefined;
  time: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
      <ArtifactActor actor={actor} />
      <span className="shrink-0">{time}</span>
    </span>
  );
}

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
      <span className="truncate">{actor.name}</span>
    </span>
  );
}

export function PaneFrame({ full, children }: { full?: boolean; children: React.ReactNode }) {
  return (
    <section
      aria-label={m.doc_pane_label()}
      className={cn(
        "@container/doc flex min-h-0 flex-col bg-primary animate-in fade-in slide-in-from-right-3 motion-enter-sm motion-reduce:animate-none",
        "max-md:w-full max-md:min-w-0 max-md:flex-1 max-md:border-l-0",
        full
          ? "fixed inset-0 z-40 min-w-0"
          : "w-[min(48rem,56%)] shrink-0 border-l border-secondary",
      )}
    >
      {children}
    </section>
  );
}
