import { useEffect, useMemo, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Lock01, Trash01 } from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import { loadArtifactMarks } from "./artifact-gallery.functions";
import { CardBadges } from "./artifact-gallery-card";
import { useScopeOf } from "./artifact-scope";
import { MarkdownPreview, stripLeadingTitleHeading } from "./artifact-preview";
import { entryFactsLine } from "./artifact-entry-facts";
import {
  analyzeBodyArtifacts,
  artifactLinksInBody,
  type ArtifactBodyLink,
  type BodyArtifactAnalysis,
} from "./artifact-link";
import { ArtifactInlineEmbed } from "./artifact-inline-embed";
import { ArtifactEditedLine, ArtifactIcon, kindLabel, useArtifactTime } from "./artifact-parts";
import {
  artifactCardQuery,
  artifactMarksQuery,
  useArtifactActor,
  type ArtifactCard,
} from "./artifact-queries";
import { useArtifactLink } from "./artifact-beside-chat";
import { useOptionalInlineEmbedPool } from "./inline-embed-pool-context";

export type ArtifactCardState = {
  artifactId: string;
  state: "open" | "forbidden" | "deleted";
};

export function MessageArtifactCards({
  body,
  links: providedLinks,
  states,
  selectionActive = false,
  excludeIds,
}: {
  body: string;
  links?: readonly ArtifactBodyLink[];
  states?: readonly ArtifactCardState[];
  selectionActive?: boolean;
  excludeIds?: ReadonlySet<string>;
}) {
  const links = useMemo(() => {
    const base = providedLinks ?? artifactLinksInBody(body);
    return excludeIds && excludeIds.size > 0
      ? base.filter((link) => !excludeIds.has(link.id))
      : base;
  }, [body, providedLinks, excludeIds]);
  if (links.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {links.map((link) => {
        const state = states?.find((entry) => entry.artifactId === link.id)?.state;
        return state === "forbidden" || state === "deleted" ? (
          <ArtifactCardPlaceholder key={link.id} artifactId={link.id} state={state} />
        ) : (
          <ArtifactCardView
            key={link.id}
            artifactId={link.id}
            embed={link.embed}
            version={link.version}
            selectionActive={selectionActive}
          />
        );
      })}
    </div>
  );
}

export type MessageArtifactLayout = BodyArtifactAnalysis & {
  cardsById: ReadonlyMap<string, ArtifactCard>;
};

export function useMessageArtifactLayout(
  body: string,
  states?: readonly ArtifactCardState[],
): MessageArtifactLayout {
  const links = useMemo(() => artifactLinksInBody(body), [body]);
  const untitled = m.doc_untitled();
  const cards = useQueries({
    queries: links.map((link) => artifactCardQuery(link.id)),
    combine: (results) => {
      const loaded: ArtifactCard[] = [];
      for (const { data } of results) {
        if (data) loaded.push(data);
      }
      return loaded;
    },
  });
  return useMemo(() => {
    const cardsById = new Map<string, ArtifactCard>();
    const titles = new Map<string, string>();
    const embedCandidates = new Set<string>();
    const placeholders = new Set<string>();
    for (const entry of states ?? []) {
      if (entry.state !== "open") placeholders.add(entry.artifactId.toLowerCase());
    }
    for (const card of cards) {
      cardsById.set(card.id, card);
      titles.set(card.id, card.title || untitled);
      if (card.entryKind === "html" && !placeholders.has(card.id.toLowerCase())) {
        embedCandidates.add(card.id);
      }
    }
    const analysis = analyzeBodyArtifacts(body, links, embedCandidates, titles, placeholders);
    return { ...analysis, cardsById };
  }, [body, links, cards, states, untitled]);
}

export function useBodyWithArtifactTitles(
  body: string,
  states?: readonly ArtifactCardState[],
): string {
  return useMessageArtifactLayout(body, states).displayBody;
}

function ArtifactCardView({
  artifactId,
  embed = false,
  version,
  selectionActive = false,
}: {
  artifactId: string;
  embed?: boolean;
  version?: number;
  selectionActive?: boolean;
}) {
  const pool = useOptionalInlineEmbedPool();
  const { data: card, isPending } = useQuery(artifactCardQuery(artifactId));
  useEffect(() => {
    if (!isPending && card === null) pool?.evictArtifact(artifactId);
  }, [pool, artifactId, isPending, card]);
  if (!card) return null;
  if (embed && card.entryKind === "html") {
    return <ArtifactInlineEmbed card={card} version={version} selectionActive={selectionActive} />;
  }
  return <ArtifactCardWithMarks card={card} />;
}

function ArtifactCardWithMarks({ card }: { card: ArtifactCard }) {
  const { data: marks } = useQuery(artifactMarksQuery(card.id));
  const linkTo = useArtifactLink();
  return (
    <ArtifactCardFace
      card={card}
      showsWhoCanSee={marks != null}
      marks={marks ?? undefined}
      title={(title) => (
        <Link
          {...linkTo(card.id)}
          onClick={(event) => event.stopPropagation()}
          className="min-w-0 truncate text-left text-sm font-semibold text-primary outline-none before:absolute before:inset-0 before:rounded-xl"
        >
          {title}
        </Link>
      )}
    />
  );
}

type CardMarks = NonNullable<Awaited<ReturnType<typeof loadArtifactMarks>>[number]>;

export function ArtifactCardFace({
  card,
  showsWhoCanSee,
  marks,
  title: titleAs,
}: {
  card: ArtifactCard;
  showsWhoCanSee?: boolean;
  marks?: CardMarks;
  title?: (title: string) => ReactNode;
}) {
  const actorOf = useArtifactActor();
  const time = useArtifactTime();
  const title = card.title || m.doc_untitled();
  const kind = kindLabel(card.entryPath);
  const facts = entryFactsLine(card.entryKind, card.entryFacts);
  const scope = useScopeOf()({
    access: card.access,
    homeKey: card.homeKey ?? "",
  });
  return (
    <article
      aria-label={m.doc_card_label({ kind, title })}
      className="relative flex w-full max-w-[34rem] items-start gap-3 rounded-xl border border-secondary bg-primary p-3 transition-[border-color] duration-100 [@media(hover:hover)]:has-[a:hover]:border-primary has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-focus-ring"
    >
      <ArtifactIcon entryPath={card.entryPath} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          {titleAs ? (
            titleAs(title)
          ) : (
            <span className="min-w-0 truncate text-sm font-semibold text-primary">{title}</span>
          )}
          <span className="shrink-0 text-xs text-quaternary tabular-nums">
            v{card.currentVersion}
          </span>
          <span className="shrink-0 text-xs text-quaternary">{kind}</span>
          {marks && (
            <ArrowUpRight
              aria-hidden="true"
              className="ml-auto size-4 shrink-0 text-fg-quaternary"
            />
          )}
        </p>
        {facts && (
          <p data-artifact-facts className="mt-0.5 truncate text-xs text-tertiary tabular-nums">
            {facts}
          </p>
        )}
        {card.preview && (
          <div className="mt-0.5 line-clamp-2 text-sm text-tertiary">
            <MarkdownPreview markdown={stripLeadingTitleHeading(card.preview, card.title)} />
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ArtifactEditedLine actor={actorOf(card.author)} time={time(card.updatedAt)} />
          {showsWhoCanSee && (
            <span className="flex items-center gap-1 text-xs text-tertiary">
              <scope.Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="max-w-32 truncate">{scope.label}</span>
            </span>
          )}
          {marks && <CardBadges card={marks} />}
        </div>
      </div>
    </article>
  );
}

function ArtifactCardPlaceholder({
  artifactId,
  state,
}: {
  artifactId: string;
  state: "forbidden" | "deleted";
}) {
  const pool = useOptionalInlineEmbedPool();
  useEffect(() => {
    pool?.evictArtifact(artifactId);
  }, [pool, artifactId]);
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
