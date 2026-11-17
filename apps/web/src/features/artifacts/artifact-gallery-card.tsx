import { Link } from "@tanstack/react-router";
import { Code01 } from "@untitledui/icons";

import { RelativeTime } from "#src/components/ui/relative-time";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { messageSlots } from "#src/lib/message-slots";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { GallerySort } from "./artifact-gallery-model";
import { GalleryCardVisibility } from "./artifact-gallery-visibility";
import { artifactDownloadUrl } from "./artifact-download-url";
import { ArtifactActor, kindName } from "./artifact-parts";
import { artifactKindOfPath, type ArtifactPathKind } from "./artifact-path-kind";
import { MarkdownPreview } from "./artifact-preview";
import { useArtifactActor } from "./artifact-queries";
import { artifactPageRoute, galleryEntryState } from "./artifact-search";
import type { GalleryCard, useScopeOf } from "./artifact-scope";

export function CardBadges({
  card,
}: {
  card: Pick<GalleryCard, "hasUpdates" | "newComments" | "mentionsYou">;
}) {
  const badges: string[] = [];
  if (card.hasUpdates) badges.push(m.av_card_updates());
  if (card.newComments > 0) badges.push(m.av_card_new_comments({ count: card.newComments }));
  if (card.mentionsYou) badges.push(m.av_card_mention());
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((badge) => (
        <span
          key={badge}
          className="rounded-md bg-brand-secondary px-1.5 py-0.5 text-xs font-medium text-brand-secondary"
        >
          {badge}
        </span>
      ))}
    </span>
  );
}

function Preview({ card }: { card: GalleryCard }) {
  const kind = artifactKindOfPath(card.entryPath);
  if (kind === "image") return <ImagePreview card={card} />;
  if (kind !== "markdown") return <KindTag kind={kind} />;
  return (
    <div
      className={cn(
        "h-full overflow-hidden px-3 pt-3 text-xs/5 text-tertiary",
        "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]",
      )}
    >
      <MarkdownPreview markdown={card.preview} />
    </div>
  );
}

function KindTag({ kind }: { kind: ArtifactPathKind }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-secondary text-fg-quaternary">
      {kind === "html" && <Code01 aria-hidden="true" className="size-6" />}
      <span
        data-artifact-kind={kind}
        className="rounded-md bg-primary px-1.5 py-0.5 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset"
      >
        {kind === "html" ? m.ag_html_tag() : kindName(kind)}
      </span>
    </div>
  );
}

function ImagePreview({ card }: { card: GalleryCard }) {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <img
      src={artifactDownloadUrl(workspaceSlug, card.id, {
        path: card.entryPath,
        version: card.currentVersion,
      })}
      alt=""
      loading="lazy"
      decoding="async"
      data-artifact-kind="image"
      className="size-full bg-secondary object-cover"
    />
  );
}

export function GalleryGridCard({
  card,
  sort,
  scope,
}: {
  card: GalleryCard;
  sort: GallerySort;
  scope: ReturnType<ReturnType<typeof useScopeOf>>;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const actorOf = useArtifactActor();
  return (
    <article className="relative flex flex-col overflow-hidden rounded-xl border border-secondary bg-primary transition hover:border-primary has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-focus-ring">
      <div className="h-32 border-b border-secondary">
        <Preview card={card} />
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <Link
            {...artifactPageRoute(workspaceSlug, card.id)}
            state={galleryEntryState}
            className="min-w-0 truncate text-sm font-semibold text-primary outline-none before:absolute before:inset-0"
          >
            {card.title || m.doc_untitled()}
          </Link>
          <span className="shrink-0 text-xs text-tertiary tabular-nums">
            v{card.currentVersion}
          </span>
        </p>
        <div className="flex items-center justify-between gap-2 text-xs text-tertiary">
          <ArtifactActor actor={actorOf(card.author)} />
          <GalleryCardVisibility artifactId={card.id} tier={card.access} scope={scope} />
        </div>
        <CardBadges card={card} />
        <WhenLine card={card} sort={sort} className="text-xs text-quaternary" />
      </div>
    </article>
  );
}

export function WhenLine({
  card,
  sort,
  className,
}: {
  card: GalleryCard;
  sort: GallerySort;
  className?: string;
}) {
  const opened = sort === "opened" && card.openedAt !== null;
  const moment = opened ? card.openedAt! : card.updatedAt;
  const time = <RelativeTime value={moment} plain />;
  return <p className={className}>{messageSlots(opened ? m.ag_opened : m.ag_updated, { time })}</p>;
}
