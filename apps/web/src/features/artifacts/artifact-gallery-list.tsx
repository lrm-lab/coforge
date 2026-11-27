import { memo, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import * as motion from "motion/react-m";
import { Focusable } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { DURATION_S, EASE_IN_OUT } from "#src/utils/motion-tokens";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { CardBadges } from "./artifact-gallery-card";
import { useScopeOf, type GalleryCard } from "./artifact-scope";
import type { GallerySort } from "./artifact-gallery-model";
import { ArtifactActor, ArtifactIcon } from "./artifact-parts";
import { useArtifactActor } from "./artifact-queries";

const LAYOUT_TRANSITION = {
  layout: { duration: DURATION_S.md, ease: EASE_IN_OUT },
} as const;

const GalleryListRow = memo(function GalleryListRow({
  card,
  sort,
  reduced,
  numberFormat,
}: {
  card: GalleryCard;
  sort: GallerySort;
  reduced: boolean;
  numberFormat: Intl.NumberFormat;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const actorOf = useArtifactActor();
  const scopeOf = useScopeOf();
  const scope = scopeOf(card);
  const moment = sort === "opened" && card.openedAt ? card.openedAt : card.updatedAt;
  const displayTitle = card.title || m.doc_untitled();
  const commentCount = numberFormat.format(card.commentCount);
  return (
    <motion.tr
      layout={reduced ? false : "position"}
      layoutId={reduced ? undefined : `gallery-item-${card.id}`}
      transition={LAYOUT_TRANSITION}
      className="relative border-b border-secondary hover:bg-primary_hover"
    >
      <td className="max-w-0 overflow-hidden py-2 pr-3">
        <span className="flex min-w-0 items-center gap-2">
          <ArtifactIcon entryPath={card.entryPath} size="sm" />
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <Tooltip title={displayTitle} placement="bottom start">
              <Focusable>
                <Link
                  to="/w/$workspaceSlug/artifacts"
                  params={{ workspaceSlug }}
                  search={{ artifact: card.id }}
                  resetScroll={false}
                  className="min-w-0 max-w-full truncate font-semibold text-primary outline-focus-ring after:absolute after:inset-0 focus-visible:outline-2"
                >
                  <span className="inline-block max-w-full truncate align-bottom">
                    {displayTitle}
                  </span>
                </Link>
              </Focusable>
            </Tooltip>
            <CardBadges card={card} />
          </span>
        </span>
      </td>
      <td className="max-w-0 overflow-hidden px-3 py-2 text-tertiary">
        <ArtifactActor actor={actorOf(card.author)} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-tertiary">
        <RelativeTime value={moment} plain />
      </td>
      <td className="px-3 py-2 text-right text-tertiary tabular-nums">{commentCount}</td>
      <td className="max-w-0 overflow-hidden py-2 pl-3">
        <span className="flex min-w-0 items-center gap-1.5 text-tertiary">
          <scope.Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{scope.label}</span>
        </span>
      </td>
    </motion.tr>
  );
});

export const GalleryList = memo(function GalleryList({
  cards,
  sort,
}: {
  cards: GalleryCard[];
  sort: GallerySort;
}) {
  const reduced = usePrefersReducedMotion();
  const locale = getLocale();
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] table-fixed border-collapse text-sm">
        <colgroup>
          <col className="w-[44%]" />
          <col className="w-[18%]" />
          <col className="w-[14%]" />
          <col className="w-[9%]" />
          <col className="w-[15%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-secondary text-left text-xs font-medium text-tertiary">
            <th className="py-2 pr-3">{m.ag_col_title()}</th>
            <th className="px-3 py-2">{m.ag_col_author()}</th>
            <th className="px-3 py-2">
              {sort === "opened" ? m.ag_col_opened() : m.ag_col_updated()}
            </th>
            <th className="px-3 py-2 text-right">{m.ag_col_comments()}</th>
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
              numberFormat={numberFormat}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});
