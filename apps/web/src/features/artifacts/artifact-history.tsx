import { Button as AriaButton } from "react-aria-components";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactActor, useArtifactTime, versionLabel } from "./artifact-parts";
import {
  artifactHistoryQuery,
  useArtifactActor,
  type ArtifactHistoryVersion,
} from "./artifact-queries";

/**
 * A document's versions, newest first (task #385): each its number, who saved it and when, its
 * note, and whether it merged others' changes or went back to an earlier version. Choosing one
 * shows it, read-only, in the pane; the latest is the one being edited.
 */
export function ArtifactHistory({
  artifactId,
  shown,
  onShow,
}: {
  artifactId: string;
  /** The version the pane shows; undefined for the latest. */
  shown: number | undefined;
  onShow: (version: number | undefined) => void;
}) {
  const [pages, setPages] = useState<(number | undefined)[]>([undefined]);
  return (
    <nav aria-label={m.doc_history()} className="flex min-h-0 flex-col">
      <h3 className="px-4 pt-4 pb-2 text-xs font-semibold text-tertiary">{m.doc_history()}</h3>
      <ol className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {pages.map((before, index) => (
          <HistoryPage
            key={before ?? "latest"}
            artifactId={artifactId}
            before={before}
            first={index === 0}
            shown={shown}
            onShow={onShow}
            onMore={
              index === pages.length - 1
                ? (next) => setPages((all) => (all.includes(next) ? all : [...all, next]))
                : undefined
            }
          />
        ))}
      </ol>
    </nav>
  );
}

function HistoryPage({
  artifactId,
  before,
  first,
  shown,
  onShow,
  onMore,
}: {
  artifactId: string;
  before: number | undefined;
  first: boolean;
  shown: number | undefined;
  onShow: (version: number | undefined) => void;
  onMore?: (before: number) => void;
}) {
  const { data, isPending, isError } = useQuery(artifactHistoryQuery(artifactId, before));
  if (isPending) return <li className="px-2 py-2 text-sm text-tertiary">…</li>;
  if (isError)
    return <li className="px-2 py-2 text-sm text-error-primary">{m.doc_history_failed()}</li>;
  if (first && data.versions.length === 0)
    return <li className="px-2 py-2 text-sm text-tertiary">{m.doc_history_empty()}</li>;
  return (
    <>
      {data.versions.map((version, index) => {
        const latest = first && index === 0;
        return (
          <HistoryRow
            key={version.number}
            version={version}
            latest={latest}
            current={
              latest ? shown === undefined || shown === version.number : shown === version.number
            }
            onShow={() => onShow(latest ? undefined : version.number)}
          />
        );
      })}
      {data.nextBefore !== null && onMore && (
        <li className="px-1 pt-1">
          <Button size="xs" color="link-gray" onClick={() => onMore(data.nextBefore!)}>
            {m.doc_history_more()}
          </Button>
        </li>
      )}
    </>
  );
}

function HistoryRow({
  version,
  latest,
  current,
  onShow,
}: {
  version: ArtifactHistoryVersion;
  latest: boolean;
  current: boolean;
  onShow: () => void;
}) {
  const actorOf = useArtifactActor();
  const time = useArtifactTime();
  const merged = version.merged as { files?: unknown[]; settings?: unknown[] } | null;
  const mergedIn = Boolean(
    merged && ((merged.files?.length ?? 0) > 0 || (merged.settings?.length ?? 0) > 0),
  );
  return (
    <li>
      <AriaButton
        aria-current={current ? "true" : undefined}
        onPress={onShow}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left outline-focus-ring hover:bg-primary_hover data-focus-visible:outline-2",
          current && "bg-active hover:bg-active",
        )}
      >
        <span className="flex items-center gap-1.5 text-sm font-semibold text-primary">
          {versionLabel(version.number)}
          {latest && (
            <Badge type="color" size="sm" color="success">
              {m.doc_history_latest()}
            </Badge>
          )}
          {mergedIn && (
            <Badge type="color" size="sm" color="gray">
              {m.doc_history_merged()}
            </Badge>
          )}
          {version.revertedFrom !== null && (
            <Badge type="color" size="sm" color="gray">
              {m.doc_history_reverted()}
            </Badge>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-tertiary">
          <ArtifactActor actor={actorOf(version.publisher)} />
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{time(version.createdAt)}</span>
        </span>
        {(version.note || version.revertedFrom !== null) && (
          <span className="line-clamp-2 text-xs text-tertiary">
            {version.revertedFrom !== null
              ? m.doc_history_reverted_from({ number: String(version.revertedFrom) })
              : version.note}
          </span>
        )}
      </AriaButton>
    </li>
  );
}
