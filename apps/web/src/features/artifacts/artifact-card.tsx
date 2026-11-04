import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { Button as AriaButton } from "react-aria-components";
import { m } from "#src/paraglide/messages";
import { artifactIdsInBody, bodyWithArtifactTitles } from "./artifact-link";
import { ArtifactEditedLine, ArtifactIcon, kindLabel, useArtifactTime } from "./artifact-parts";
import { artifactCardQuery, useArtifactActor, useArtifactsOn } from "./artifact-queries";
import { useOpenArtifactPage } from "./artifact-search";

/**
 * The cards of the artifacts a message links to (task #385, #514): each its kind, title, first
 * two lines, version and who changed it last; the card opens it. Nothing
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
  const openPage = useOpenArtifactPage();
  if (!card) return null;
  const title = card.title || m.doc_untitled();
  const kind = kindLabel(card.kind);
  return (
    <article
      aria-label={m.doc_card_label({ kind, title })}
      className="relative flex w-full max-w-[34rem] items-start gap-3 rounded-xl border border-secondary bg-primary p-3 shadow-xs transition has-[button:hover]:border-primary has-[button:hover]:shadow-sm has-[button[data-focus-visible]]:outline-2 has-[button[data-focus-visible]]:outline-focus-ring"
    >
      <ArtifactIcon kind={card.kind} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          {/* The title is the card's one way in; its hit area covers the whole card. */}
          <AriaButton
            onPress={() => openPage(card.id)}
            className="min-w-0 truncate text-left text-sm font-semibold text-primary outline-none before:absolute before:inset-0 before:rounded-xl"
          >
            {title}
          </AriaButton>
          <span className="shrink-0 text-xs text-quaternary">{kind}</span>
        </p>
        {card.preview && (
          <p className="mt-0.5 line-clamp-2 text-sm whitespace-pre-line text-tertiary">
            {card.preview}
          </p>
        )}
        <div className="mt-2">
          <ArtifactEditedLine
            version={card.currentVersion}
            actor={actorOf(card.author)}
            time={time(card.updatedAt)}
          />
        </div>
      </div>
    </article>
  );
}
