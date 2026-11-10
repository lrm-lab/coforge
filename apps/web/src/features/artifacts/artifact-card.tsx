import { useMemo, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { Link } from "@tanstack/react-router";
import { Lock01, Trash01 } from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import { artifactIdsInBody, bodyWithArtifactTitles } from "./artifact-link";
import { ArtifactEditedLine, ArtifactIcon, kindLabel, useArtifactTime } from "./artifact-parts";
import {
  artifactCardQuery,
  useArtifactActor,
  useArtifactsOn,
  type ArtifactCard,
} from "./artifact-queries";
import { useArtifactLink } from "./artifact-beside-chat";

/** How the server's read of a message saw one artifact it links to, for this reader: one they
 * may open, one they may not (nothing of it is shown), or one deleted (said only to those who
 * could open it). */
export type ArtifactCardState = {
  artifactId: string;
  state: "open" | "forbidden" | "deleted";
};

/**
 * The cards of the artifacts a message links to (task #385, #514): each its kind, title, first
 * two lines, version and who changed it last; the card is a link to its page. A link the
 * message's read (`states`) found shut to this reader shows one line saying so, never its title;
 * a deleted one says it was deleted. Nothing shows while documents are off, or before the card is
 * read.
 */
export function MessageArtifactCards({
  body,
  states,
}: {
  body: string;
  states?: readonly ArtifactCardState[];
}) {
  const on = useArtifactsOn();
  const ids = on ? artifactIdsInBody(body) : [];
  if (ids.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {ids.map((id) => {
        const state = states?.find((entry) => entry.artifactId === id)?.state;
        return state === "forbidden" || state === "deleted" ? (
          <ArtifactCardPlaceholder key={id} state={state} />
        ) : (
          <ArtifactCardView key={id} artifactId={id} />
        );
      })}
    </div>
  );
}

/** `body` as it reads beside its documents' cards (`bodyWithArtifactTitles`), from the cards
 * already read and the read's `states`: a link reads as written until its card shows. */
export function useBodyWithArtifactTitles(
  body: string,
  states?: readonly ArtifactCardState[],
): string {
  const on = useArtifactsOn();
  const cards = useQueries({
    queries: (on ? artifactIdsInBody(body) : []).map((id) => artifactCardQuery(id)),
  });
  const shown = cards.flatMap(({ data }) =>
    data ? [[data.id, data.title || m.doc_untitled()] as const] : [],
  );
  // The cards read anew on every render; their titles, as one string, change far less.
  const titles = JSON.stringify(shown);
  const placeholders = on
    ? JSON.stringify(
        (states ?? []).flatMap((entry) =>
          entry.state === "open" ? [] : [entry.artifactId.toLowerCase()],
        ),
      )
    : "[]";
  return useMemo(
    () =>
      bodyWithArtifactTitles(
        body,
        new Map(JSON.parse(titles) as [string, string][]),
        new Set(JSON.parse(placeholders) as string[]),
      ),
    [body, titles, placeholders],
  );
}

function ArtifactCardView({ artifactId }: { artifactId: string }) {
  const { data: card } = useQuery(artifactCardQuery(artifactId));
  const linkTo = useArtifactLink();
  if (!card) return null;
  return (
    <ArtifactCardFace
      card={card}
      title={(title) => (
        <Link
          {...linkTo(card.id)}
          // The message row opens its actions on a click; this click is the card's alone.
          onClick={(event) => event.stopPropagation()}
          className="min-w-0 truncate text-left text-sm font-semibold text-primary outline-none before:absolute before:inset-0 before:rounded-xl"
        >
          {title}
        </Link>
      )}
    />
  );
}

/** A card as it reads: kind, title, first two lines, who changed it last. `title` makes the title
 * a way in (in chat, a link over the whole card); without it the card is only shown (a preview of
 * what a send will post). */
export function ArtifactCardFace({
  card,
  title: titleAs,
}: {
  card: ArtifactCard;
  title?: (title: string) => ReactNode;
}) {
  const actorOf = useArtifactActor();
  const time = useArtifactTime();
  const title = card.title || m.doc_untitled();
  const kind = kindLabel(card.kind);
  return (
    <article
      aria-label={m.doc_card_label({ kind, title })}
      className="relative flex w-full max-w-[34rem] items-start gap-3 rounded-xl border border-secondary bg-primary p-3 transition has-[a:hover]:border-primary has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-focus-ring"
    >
      <ArtifactIcon kind={card.kind} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          {/* The title is the card's one way in; its hit area covers the whole card. */}
          {titleAs ? (
            titleAs(title)
          ) : (
            <span className="min-w-0 truncate text-sm font-semibold text-primary">{title}</span>
          )}
          <span className="shrink-0 text-xs text-quaternary">{kind}</span>
        </p>
        {card.preview && (
          <p className="mt-0.5 line-clamp-2 text-sm whitespace-pre-line text-tertiary">
            {card.preview}
          </p>
        )}
        <div className="mt-2">
          <ArtifactEditedLine actor={actorOf(card.author)} time={time(card.updatedAt)} />
        </div>
      </div>
    </article>
  );
}

/** A linked artifact this reader may not open, or one deleted: the card's frame and one line, no
 * title or text, and nothing to click. */
function ArtifactCardPlaceholder({ state }: { state: "forbidden" | "deleted" }) {
  const Icon = state === "forbidden" ? Lock01 : Trash01;
  return (
    <div className="flex w-full max-w-[34rem] items-center gap-3 rounded-xl border border-secondary bg-secondary_subtle p-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary ring-1 ring-secondary">
        <Icon aria-hidden="true" className="size-4 text-fg-quaternary" />
      </span>
      <p className="min-w-0 text-sm text-tertiary">
        {state === "forbidden" ? m.doc_card_forbidden() : m.doc_card_deleted()}
      </p>
    </div>
  );
}
