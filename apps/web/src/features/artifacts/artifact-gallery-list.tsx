import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";

import { RelativeTime } from "#src/components/ui/relative-time";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { CONTINUOUS_EASE_TUPLE } from "#src/lib/shared-element-rect";
import { m } from "#src/paraglide/messages";
import { CardBadges } from "./artifact-gallery-card";
import { useScopeOf, type GalleryCard } from "./artifact-scope";
import type { GallerySort } from "./artifact-gallery-model";
import { ArtifactActor, ArtifactIcon } from "./artifact-parts";
import { useArtifactActor } from "./artifact-queries";
import { artifactPageRoute, galleryEntryState } from "./artifact-search";
import {
  ARTIFACT_FRAME_VT_NAME,
  ARTIFACT_TITLE_VT_NAME,
  prepareArtifactViewTransition,
  useActiveArtifactTransitionId,
} from "./artifact-view-transition";

function GalleryListRow({
  card,
  sort,
  reduced,
  activeTransition,
}: {
  card: GalleryCard;
  sort: GallerySort;
  reduced: boolean;
  activeTransition: boolean;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const actorOf = useArtifactActor();
  const scopeOf = useScopeOf();
  const scope = scopeOf(card);
  const moment = sort === "opened" && card.openedAt ? card.openedAt : card.updatedAt;
  const rowRef = useRef<HTMLTableRowElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  return (
    <motion.tr
      ref={rowRef}
      layout={reduced ? false : "position"}
      layoutId={reduced ? undefined : `gallery-item-${card.id}`}
      transition={{ layout: { duration: 0.28, ease: CONTINUOUS_EASE_TUPLE } }}
      style={activeTransition ? { viewTransitionName: ARTIFACT_FRAME_VT_NAME } : undefined}
      className="relative border-b border-secondary hover:bg-primary_hover"
    >
      <td className="py-2 pr-3">
        <span className="flex min-w-0 items-center gap-2">
          <ArtifactIcon entryPath={card.entryPath} size="sm" />
          <Link
            {...artifactPageRoute(workspaceSlug, card.id)}
            state={galleryEntryState}
            viewTransition={!reduced}
            onClick={() => {
              if (!reduced) {
                prepareArtifactViewTransition(card.id, {
                  frame: rowRef.current,
                  title: titleRef.current,
                });
              }
            }}
            className="min-w-0 truncate font-semibold text-primary outline-focus-ring after:absolute after:inset-0 focus-visible:outline-2"
          >
            <span
              ref={titleRef}
              style={activeTransition ? { viewTransitionName: ARTIFACT_TITLE_VT_NAME } : undefined}
              className="inline-block max-w-full truncate align-bottom"
            >
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
  const activeTransitionId = useActiveArtifactTransitionId();
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
            <GalleryListRow
              key={card.id}
              card={card}
              sort={sort}
              reduced={reduced}
              activeTransition={!reduced && activeTransitionId === card.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
