import { useMemo, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Lock01, Trash01 } from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import { loadArtifactMarks } from "./artifact-gallery.functions";
import { CardBadges } from "./artifact-gallery-card";
import { useScopeOf } from "./artifact-scope";
import { plainPreview } from "./artifact-preview";
import { artifactIdsInBody, bodyWithArtifactTitles } from "./artifact-link";
import { ArtifactEditedLine, ArtifactIcon, kindLabel, useArtifactTime } from "./artifact-parts";
import {
  artifactCardQuery,
  artifactMarksQuery,
  useArtifactActor,
  useArtifactsOn,
  type ArtifactCard,
} from "./artifact-queries";
import { useArtifactLink } from "./artifact-beside-chat";

export type ArtifactCardState = {
  artifactId: string;
  state: "open" | "forbidden" | "deleted";
};

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
  const { data: marks } = useQuery(artifactMarksQuery(artifactId));
  const linkTo = useArtifactLink();
  if (!card) return null;
  return (
    <ArtifactCardFace
      card={card}
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
  marks,
  asPreview = false,
  title: titleAs,
}: {
  card: ArtifactCard;
  marks?: CardMarks;
  asPreview?: boolean;
  title?: (title: string) => ReactNode;
}) {
  const actorOf = useArtifactActor();
  const time = useArtifactTime();
  const title = card.title || m.doc_untitled();
  const kind = kindLabel(card.entryPath);
  const scope = useScopeOf()({
    link: marks?.link === true,
    access: card.access,
    homeKey: card.homeKey ?? "",
  });
  return (
    <article
      aria-label={m.doc_card_label({ kind, title })}
      className="relative flex w-full max-w-[34rem] items-start gap-3 rounded-xl border border-secondary bg-primary p-3 transition has-[a:hover]:border-primary has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-focus-ring"
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
          {marks && !asPreview && (
            <ArrowUpRight
              aria-hidden="true"
              className="ml-auto size-4 shrink-0 text-fg-quaternary"
            />
          )}
        </p>
        {card.preview && (
          <p className="mt-0.5 line-clamp-2 text-sm whitespace-pre-line text-tertiary">
            {plainPreview(card.preview)}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ArtifactEditedLine actor={actorOf(card.author)} time={time(card.updatedAt)} />
          {marks && (
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
