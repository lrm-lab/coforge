import { Link } from "@tanstack/react-router";
import { memo, useState } from "react";
import { Focusable } from "react-aria-components";
import { MessageSquare01 } from "@untitledui/icons";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { messageSlots } from "#src/lib/message-slots";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { commentsCap } from "./artifact-comment-threads";
import { useGalleryCardMenu } from "./artifact-gallery-context-menu";
import type { GallerySort } from "./artifact-gallery-model";
import { GalleryCardVisibility } from "./artifact-gallery-visibility";
import { artifactDownloadUrl, artifactThumbnailUrl } from "./artifact-download-url";
import { ArtifactActor, KIND_ICONS, kindName } from "./artifact-parts";
import { artifactKindOfPath, type ArtifactPathKind } from "./artifact-path-kind";
import { MarkdownPreview, stripLeadingTitleHeading } from "./artifact-preview";
import { useArtifactActor } from "./artifact-queries";
import { useScopeOf, type GalleryCard } from "./artifact-scope";
import { SettledBadge } from "./artifact-settlement-control";

export function CardBadges({
  card,
  showSettled = true,
}: {
  card: Pick<GalleryCard, "hasUpdates" | "newComments" | "mentionsYou"> & {
    settled?: GalleryCard["settled"];
  };
  showSettled?: boolean;
}) {
  const badges: string[] = [];
  if (card.hasUpdates) badges.push(m.av_card_updates());
  if (card.newComments > 0) badges.push(m.av_card_new_comments({ count: card.newComments }));
  if (card.mentionsYou) badges.push(m.av_card_mention());
  const showBadge = showSettled && card.settled;
  if (!showBadge && badges.length === 0) return null;
  return (
    <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      {showBadge && <SettledBadge label={m.av_settled_badge()} settled={card.settled} />}
      {badges.map((badge) => (
        <span
          key={badge}
          className="shrink-0 whitespace-nowrap rounded-md bg-brand-secondary px-1.5 py-0.5 text-xs font-medium text-brand-secondary"
        >
          {badge}
        </span>
      ))}
    </span>
  );
}

function Preview({ card }: { card: GalleryCard }) {
  const kind = artifactKindOfPath(card.entryPath);
  if (kind === "image") return <ImagePreview key={card.currentVersion} card={card} />;
  if (kind !== "markdown") return <KindTag kind={kind} />;
  return (
    <div
      className={cn(
        "h-full overflow-hidden px-3 pt-10 text-xs/5 text-tertiary",
        "[mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
      )}
    >
      <MarkdownPreview markdown={stripLeadingTitleHeading(card.preview, card.title)} />
    </div>
  );
}

function KindTag({ kind }: { kind: ArtifactPathKind }) {
  const Icon = KIND_ICONS[kind];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-secondary text-fg-quaternary">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-lg bg-primary text-fg-tertiary ring-1 ring-secondary ring-inset"
      >
        <Icon className="size-5" />
      </span>
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
  const [failed, setFailed] = useState(false);
  if (failed) return <KindTag kind="image" />;
  const file = { path: card.entryPath, version: card.currentVersion };
  const url = card.entryPath.toLowerCase().endsWith(".svg")
    ? artifactDownloadUrl
    : artifactThumbnailUrl;
  return (
    <img
      src={url(workspaceSlug, card.id, file)}
      onError={() => setFailed(true)}
      alt=""
      loading="lazy"
      decoding="async"
      data-artifact-kind="image"
      className="size-full bg-secondary object-cover"
    />
  );
}

export const GalleryGridCard = memo(function GalleryGridCard({
  card,
  sort,
  dimmed = false,
}: {
  card: GalleryCard;
  sort: GallerySort;
  dimmed?: boolean;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const actorOf = useArtifactActor();
  const scopeOf = useScopeOf();
  const scope = scopeOf(card);
  const displayTitle = card.title || m.doc_untitled();
  const { cardRef, onContextMenu, onKeyDown, renderMenu } = useGalleryCardMenu(card);
  return (
    <article
      ref={cardRef}
      data-artifact-card={card.id}
      data-settled={card.settled ? "" : undefined}
      data-dimmed={dimmed ? "" : undefined}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      className={cn(
        "group/card relative flex flex-col overflow-hidden rounded-xl border border-secondary bg-primary transition-[border-color,opacity] duration-150 hover:border-primary has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-focus-ring",
        dimmed && "grayscale opacity-60 hover:opacity-85 focus-within:opacity-85",
      )}
    >
      <div className="relative h-32 border-b border-secondary">
        <Preview card={card} />
        <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1">
          {card.settled && (
            <span className="pointer-events-auto inline-flex rounded-md bg-primary shadow-xs">
              <SettledBadge label={m.av_settled_badge()} settled={card.settled} />
            </span>
          )}
          {renderMenu(
            "pointer-events-auto bg-primary shadow-xs ring-1 ring-secondary opacity-80 group-hover/card:opacity-100 group-focus-within/card:opacity-100 data-[open=true]:opacity-100 hover:bg-primary_hover",
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <Tooltip title={displayTitle} placement="bottom start">
            <Focusable>
              <Link
                to="/w/$workspaceSlug/artifacts"
                params={{ workspaceSlug }}
                search={{ artifact: card.id }}
                resetScroll={false}
                data-artifact-open=""
                className="min-w-0 truncate text-sm font-semibold text-primary outline-none before:absolute before:inset-0"
              >
                <span className="inline-block max-w-full truncate align-bottom">
                  {displayTitle}
                </span>
              </Link>
            </Focusable>
          </Tooltip>
          <span className="shrink-0 text-xs text-tertiary tabular-nums">
            v{card.currentVersion}
          </span>
        </p>
        <div className="flex items-center justify-between gap-2 text-xs text-tertiary">
          <ArtifactActor actor={actorOf(card.author)} />
          <div className="flex shrink-0 items-center gap-1.5">
            {card.commentCount > 0 && (
              <span
                aria-label={m.ag_card_comments({ count: card.commentCount })}
                className="inline-flex items-center gap-1 text-xs text-tertiary tabular-nums"
              >
                <MessageSquare01 aria-hidden="true" className="size-3.5 shrink-0" />
                <span>{commentsCap(card.commentCount)}</span>
              </span>
            )}
            <GalleryCardVisibility artifactId={card.id} tier={card.access} scope={scope} />
          </div>
        </div>
        <CardBadges card={card} showSettled={false} />
        <WhenLine card={card} sort={sort} className="text-xs text-quaternary" />
      </div>
    </article>
  );
});

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
