import { Link } from "@tanstack/react-router";
import { Building02, Code01, Globe02, MessageChatCircle } from "@untitledui/icons";

import { RelativeTime } from "#src/components/ui/relative-time";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { messageSlots } from "#src/lib/message-slots";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { loadArtifactGallery } from "./artifact-gallery.functions";
import type { GallerySort } from "./artifact-gallery-model";
import { useConversationName } from "./artifact-gallery-filters";
import { ArtifactActor } from "./artifact-parts";
import { isWebPageEntry } from "./artifact-path-kind";
import { useArtifactActor } from "./artifact-queries";
import { artifactPageRoute } from "./artifact-search";

export type GalleryCard = Awaited<ReturnType<typeof loadArtifactGallery>>["artifacts"][number];

export function useScopeOf() {
  const nameOf = useConversationName();
  return (card: GalleryCard) => {
    if (card.link) return { Icon: Globe02, label: m.av_vis_link() };
    if (card.access === "workspace") return { Icon: Building02, label: m.av_vis_workspace() };
    const id = card.homeKey.replace(/^conversation:/, "");
    return { Icon: MessageChatCircle, label: nameOf(id) ?? m.av_vis_home_dm() };
  };
}

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
  if (isWebPageEntry(card.entryPath))
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-secondary text-fg-quaternary">
        <Code01 aria-hidden="true" className="size-6" />
        <span className="rounded-md bg-primary px-1.5 py-0.5 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset">
          {m.ag_html_tag()}
        </span>
      </div>
    );
  return (
    <p
      className={cn(
        "h-full overflow-hidden px-3 pt-3 text-xs/5 whitespace-pre-line text-tertiary",
        "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]",
      )}
    >
      {card.preview}
    </p>
  );
}

export function GalleryGridCard({ card, sort }: { card: GalleryCard; sort: GallerySort }) {
  const workspaceSlug = useWorkspaceSlug();
  const actorOf = useArtifactActor();
  const scopeOf = useScopeOf();
  const scope = scopeOf(card);
  return (
    <article className="relative flex flex-col overflow-hidden rounded-xl border border-secondary bg-primary transition hover:border-primary has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-focus-ring">
      <div className="h-32 border-b border-secondary">
        <Preview card={card} />
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <Link
            {...artifactPageRoute(workspaceSlug, card.id)}
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
          <scope.Icon aria-label={scope.label} className="size-3.5 shrink-0" />
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
