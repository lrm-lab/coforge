import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import { setCssHighlight } from "#src/lib/css-highlight";
import {
  COMMENT_DRAFT_HIGHLIGHT,
  COMMENT_FOCUS_HIGHLIGHT,
  type AnchorLocation,
  type AnchorPlace,
  type SurfaceAdapter,
} from "./artifact-anchor-places";
import {
  ArtifactCommentMarkers,
  stackMarkers,
  type CommentMarker,
} from "./artifact-comment-markers";
import {
  useArtifactCommenting,
  useCommentRequests,
  useCommentThreads,
} from "./artifact-commenting";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import { DraftAffordance } from "./artifact-draft-affordance";
import { linesAdapter, type LineIndex } from "./artifact-line-ranges";
import { textAdapter, type TextIndex } from "./artifact-text-ranges";
import { useAnchorDraft } from "./use-anchor-draft";
import { useFlash } from "./use-flash";
import { useSurfaceIndex } from "./use-surface-index";
import { useLinesOffer, useTextOffer, type Offer, type OfferInput } from "./use-surface-offers";

const MARGIN_MIN_PX = 44;
const MARGIN_OFFSET_PX = 4;
const EMPTY_PLACES: ReadonlyMap<string, AnchorPlace> = new Map();

type Layout = { markerLeft: number | null; revision: number };

export function ArtifactCommentSurface({
  path,
  kind,
  contentClassName,
  children,
}: {
  path: string;
  kind: "text" | "lines";
  contentClassName?: string;
  children: ReactNode;
}) {
  const shared = { path, contentClassName, children };
  return kind === "text" ? (
    <Surface<TextIndex> {...shared} adapter={textAdapter} useOffer={useTextOffer} />
  ) : (
    <Surface<LineIndex> {...shared} adapter={linesAdapter} useOffer={useLinesOffer} />
  );
}

function Surface<Index>({
  path,
  adapter,
  useOffer,
  contentClassName,
  children,
}: {
  path: string;
  adapter: Pick<SurfaceAdapter<Index, never>, "build" | "locate">;
  useOffer: (input: OfferInput<Index>) => Offer;
  contentClassName?: string;
  children: ReactNode;
}) {
  const { version, commenting, panelOpen, publishPlaces, revealThread, openThread } =
    useArtifactCommenting();
  const { reveal, consumeReveal } = useCommentRequests();
  const anchored = useCommentThreads();
  const { drafts } = useCommentDrafts();
  const { openDraft } = useCommentDraftActions();
  const reducedMotion = usePrefersReducedMotion();
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [layout, setLayout] = useState<Layout>({ markerLeft: null, revision: 0 });
  const [flashed, flash] = useFlash<AnchorLocation>();
  const active = commenting || panelOpen;
  const key = commenting ? `${path}@${version}` : null;

  const { get, settled, revision } = useSurfaceIndex(content, adapter.build, active);

  const threads = useMemo(
    () => anchored.filter((thread) => thread.root.path === path && !("deleted" in thread.root)),
    [anchored, path],
  );
  const unsent = useMemo(
    () => drafts.filter((draft) => draft.path === path && draft.anchor !== null),
    [drafts, path],
  );
  const places = useMemo<ReadonlyMap<string, AnchorPlace>>(() => {
    const index = active ? get() : null;
    if (!index) return EMPTY_PLACES;
    const found = new Map<string, AnchorPlace>();
    for (const { root } of threads)
      if (!("deleted" in root) && root.anchor)
        found.set(root.id, adapter.locate(index, root.anchor));
    for (const draft of unsent) found.set(draft.id, adapter.locate(index, draft.anchor!));
    return found;
  }, [active, get, revision, threads, unsent, version, adapter]);

  useEffect(() => {
    publishPlaces(path, places);
  }, [publishPlaces, path, places]);
  useEffect(() => () => publishPlaces(path, null), [publishPlaces, path]);

  const offers = useOffer({ get, revision, content, key, composing: composingRef });
  const draft = useAnchorDraft({ key, frame, ...offers });
  composingRef.current = draft.composing !== null;

  const focus = useCallback(
    (location: AnchorLocation) => {
      location.element.scrollIntoView({
        block: "center",
        behavior: reducedMotion ? "auto" : "smooth",
      });
      flash(location);
    },
    [flash, reducedMotion],
  );

  useEffect(() => {
    setCssHighlight(COMMENT_FOCUS_HIGHLIGHT, flashed ? [flashed.range] : []);
  }, [flashed]);
  useEffect(
    () => () => {
      setCssHighlight(COMMENT_FOCUS_HIGHLIGHT, []);
      setCssHighlight(COMMENT_DRAFT_HIGHLIGHT, []);
    },
    [],
  );

  useEffect(() => {
    if (!reveal || reveal.path !== path) return;
    const index = settled() ? get() : null;
    if (!index) return;
    if (!reveal.anchor) return consumeReveal();
    const place = adapter.locate(index, reveal.anchor);
    if (place.status !== "found") return;
    consumeReveal();
    focus(place.location);
  }, [reveal, path, get, settled, revision, adapter, consumeReveal, focus]);

  const measure = useCallback(() => {
    const outer = frame.current?.getBoundingClientRect();
    const inner = content.current?.getBoundingClientRect();
    if (!outer || !inner) return;
    const markerLeft =
      outer.right - inner.right >= MARGIN_MIN_PX
        ? inner.right - outer.left + MARGIN_OFFSET_PX
        : null;
    setLayout((current) => ({ markerLeft, revision: current.revision + 1 }));
  }, []);
  useResizeObserver({ ref: frame, onResize: measure });
  useResizeObserver({ ref: content, onResize: measure });

  const markers = useMemo<readonly CommentMarker[]>(() => {
    if (!commenting || layout.markerLeft === null) return [];
    const frameTop = frame.current?.getBoundingClientRect().top ?? 0;
    const topOf = (id: string) => {
      const place = places.get(id);
      return place?.status === "found"
        ? place.location.range.getBoundingClientRect().top - frameTop
        : null;
    };
    return stackMarkers([
      ...threads.flatMap((thread) => {
        const top = topOf(thread.root.id);
        return top === null ? [] : [{ kind: "thread" as const, thread, top }];
      }),
      ...unsent.flatMap((draft) => {
        const top = topOf(draft.id);
        return top === null ? [] : [{ kind: "draft" as const, draft, top }];
      }),
    ]);
  }, [commenting, layout, threads, unsent, places]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div ref={frame} className="relative min-h-full">
        <div ref={content} className={contentClassName} onClickCapture={offers.onContentClick}>
          {children}
        </div>
        {commenting && layout.markerLeft !== null && (
          <ArtifactCommentMarkers
            markers={markers}
            left={layout.markerLeft}
            onOpen={({ root }) => {
              if ("deleted" in root) return;
              revealThread({ path, anchor: root.anchor });
              openThread(root.id);
            }}
            onOpenDraft={openDraft}
          />
        )}
        {commenting && <DraftAffordance draft={draft} path={path} />}
      </div>
    </div>
  );
}
