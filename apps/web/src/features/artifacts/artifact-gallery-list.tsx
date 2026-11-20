import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";

import { RelativeTime } from "#src/components/ui/relative-time";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { DURATION_S, EASE_IN_OUT } from "#src/utils/motion-tokens";
import { m } from "#src/paraglide/messages";
import { CardBadges } from "./artifact-gallery-card";
import { useScopeOf, type GalleryCard } from "./artifact-scope";
import type { GallerySort } from "./artifact-gallery-model";
import { ArtifactActor, ArtifactIcon } from "./artifact-parts";
import { useArtifactActor } from "./artifact-queries";
import { artifactPageRoute, galleryEntryState } from "./artifact-search";

function GalleryListRow({
  card,
  sort,
  reduced,
}: {
  card: GalleryCard;
  sort: GallerySort;
  reduced: boolean;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const actorOf = useArtifactActor();
  const scopeOf = useScopeOf();
  const scope = scopeOf(card);
  const moment = sort === "opened" && card.openedAt ? card.openedAt : card.updatedAt;
  return (
    <motion.tr
      layout={reduced ? false : "position"}
      layoutId={reduced ? undefined : `gallery-item-${card.id}`}
      transition={{ layout: { duration: DURATION_S.md, ease: EASE_IN_OUT } }}
      className="relative border-b border-secondary hover:bg-primary_hover"
    >
      <td className="py-2 pr-3">
        <span className="flex min-w-0 items-center gap-2">
          <ArtifactIcon entryPath={card.entryPath} size="sm" />
          <Link
            {...artifactPageRoute(workspaceSlug, card.id)}
            state={galleryEntryState}
            className="min-w-0 truncate font-semibold text-primary outline-focus-ring after:absolute after:inset-0 focus-visible:outline-2"
          >
            <span className="inline-block max-w-full truncate align-bottom">
              {card.title || m.doc_untitled()}
            </span>
          </Link>
          <CardBadges card={card} />
        </span>
      </td>
      <td className="px-3 py-2 text-tertiary">
        <ArtifactActor actor={actorOf(card.author)} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-tertiary">
        <RelativeTime value={moment} plain />
      </td>
      <td className="px-3 py-2 text-tertiary tabular-nums">{card.commentCount}</td>
      <td className="py-2 pl-3">
        <span className="flex items-center gap-1.5 text-tertiary">
          <scope.Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{scope.label}</span>
        </span>
      </td>
    </motion.tr>
  );
}

export function GalleryList({ cards, sort }: { cards: GalleryCard[]; sort: GallerySort }) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-secondary text-left text-xs font-medium text-tertiary">
            <th className="py-2 pr-3">{m.ag_col_title()}</th>
            <th className="px-3 py-2">{m.ag_col_author()}</th>
            <th className="px-3 py-2">
              {sort === "opened" ? m.ag_col_opened() : m.ag_col_updated()}
            </th>
            <th className="px-3 py-2">{m.ag_col_comments()}</th>
            <th className="py-2 pl-3">{m.ag_col_visibility()}</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <GalleryListRow key={card.id} card={card} sort={sort} reduced={reduced} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
