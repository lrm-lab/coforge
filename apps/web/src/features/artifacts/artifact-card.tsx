import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { artifactIdsInBody, bodyWithArtifactTitles } from "./artifact-link";
import { ArtifactActor, ArtifactIcon, useArtifactTime, versionLabel } from "./artifact-parts";
import { artifactCardQuery, useArtifactActor, useArtifactsOn } from "./artifact-queries";
import { openArtifactSearch, useArtifactNavigation } from "./artifact-search";

/**
 * The cards of the documents a message links to (task #385): each its title, its first two
 * lines, its version and who changed it last, and Open, which shows it beside the chat. Nothing
 * shows while documents are off, for a link the reader may not open, or before the card is read.
 */
export function MessageArtifactCards({ body }: { body: string }) {
  const on = useArtifactsOn();
  const ids = on ? artifactIdsInBody(body) : [];
  if (ids.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {ids.map((id) => (
        <ArtifactCardView key={id} artifactId={id} />
      ))}
    </div>
  );
}

/** `body` as it reads beside its documents' cards (`bodyWithArtifactTitles`), from the cards
 * already read: a link reads as written until its card shows. */
export function useBodyWithArtifactTitles(body: string): string {
  const on = useArtifactsOn();
  const cards = useQueries({
    queries: (on ? artifactIdsInBody(body) : []).map((id) => artifactCardQuery(id)),
  });
  const shown = cards.flatMap(({ data }) =>
    data ? [[data.id, data.title || m.doc_untitled()] as const] : [],
  );
  // The cards read anew on every render; their titles, as one string, change far less.
  const titles = JSON.stringify(shown);
  return useMemo(
    () => bodyWithArtifactTitles(body, new Map(JSON.parse(titles) as [string, string][])),
    [body, titles],
  );
}

function ArtifactCardView({ artifactId }: { artifactId: string }) {
  const { data: card } = useQuery(artifactCardQuery(artifactId));
  const actorOf = useArtifactActor();
  const time = useArtifactTime();
  const navigate = useArtifactNavigation();
  if (!card) return null;
  const title = card.title || m.doc_untitled();
  const open = () => navigate(openArtifactSearch(card.id));
  return (
    <article
      aria-label={m.doc_card_label({ title })}
      className="group/doc flex w-full max-w-[34rem] cursor-pointer flex-col gap-2 rounded-xl border border-secondary bg-primary p-3 shadow-xs transition hover:border-brand hover:shadow-sm"
      onClick={(event) => {
        // A click on the card opens it; one that ends a text selection, or presses Open, does not.
        if (window.getSelection()?.toString()) return;
        if ((event.target as Element).closest("button")) return;
        event.stopPropagation();
        open();
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <ArtifactIcon />
        <div className="min-w-0 flex-1">
          <p className="truncate text-md font-semibold text-primary">{title}</p>
          <p className="flex min-w-0 items-center gap-1 text-xs text-tertiary">
            <span className="shrink-0">{versionLabel(card.currentVersion)}</span>
            <span aria-hidden="true">·</span>
            <ArtifactActor actor={actorOf(card.author)} />
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{time(card.updatedAt)}</span>
          </p>
        </div>
      </div>
      {card.preview && (
        <p className="line-clamp-2 text-sm whitespace-pre-line text-secondary">{card.preview}</p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          color="link-color"
          onClick={() => open()}
          // The card's own click opens it already; the button is its keyboard and reader way in.
        >
          {m.doc_card_open()}
        </Button>
      </div>
    </article>
  );
}
