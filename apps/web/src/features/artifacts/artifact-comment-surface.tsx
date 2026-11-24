import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { setCssHighlight } from "#src/lib/css-highlight";
import {
  COMMENT_DRAFT_HIGHLIGHT,
  COMMENT_FOCUS_HIGHLIGHT,
  type AnchorLocation,
  type AnchorPlace,
  type SurfaceAdapter,
} from "./artifact-anchor-places";
import { useArtifactCommenting, useCommentRequests, useShownThreads } from "./artifact-commenting";
import { useCommentDrafts } from "./artifact-comment-drafts-context";
import { DraftAffordance } from "./artifact-draft-affordance";
import { linesAdapter } from "./artifact-line-ranges";
import { textAdapter } from "./artifact-text-ranges";
import { useAnchorDraft } from "./use-anchor-draft";
import { useFlash } from "./use-flash";
import { useSurfaceIndex } from "./use-surface-index";
import { useLinesOffer, useTextOffer, type Offer, type OfferInput } from "./use-surface-offers";

const EMPTY_PLACES: ReadonlyMap<string, AnchorPlace> = new Map();

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
  return kind === "text" ? (
    <TextSurface path={path} contentClassName={contentClassName}>
      {children}
    </TextSurface>
  ) : (
    <LinesSurface path={path} contentClassName={contentClassName}>
      {children}
    </LinesSurface>
  );
}

function TextSurface({
  path,
  contentClassName,
  children,
}: {
  path: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const base = useSurfaceBase(path, textAdapter, true);
  const offers = useTextOffer(base.offerInput);
  return (
    <SurfaceView base={base} offers={offers} contentClassName={contentClassName}>
      {children}
    </SurfaceView>
  );
}

function LinesSurface({
  path,
  contentClassName,
  children,
}: {
  path: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const base = useSurfaceBase(path, linesAdapter, false);
  const offers = useLinesOffer(base.offerInput);
  return (
    <SurfaceView base={base} offers={offers} contentClassName={contentClassName}>
      {children}
    </SurfaceView>
  );
}

function useSurfaceBase<Index>(
  path: string,
  adapter: Pick<SurfaceAdapter<Index, never>, "build" | "locate">,
  alwaysOffer: boolean,
) {
  const { version, commenting, panelOpen, publishPlaces } = useArtifactCommenting();
  const { reveal, consumeReveal } = useCommentRequests();
  const anchored = useShownThreads();
  const { drafts } = useCommentDrafts();
  const reducedMotion = usePrefersReducedMotion();
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [flashed, flash] = useFlash<{ version: number; range: Range }>();
  const offerActive = commenting || alwaysOffer;
  const active = offerActive || panelOpen;
  const key = offerActive ? `${path}@${version}` : null;

  const { get, settled, revision } = useSurfaceIndex(content, adapter.build, active);

  const threads = useMemo(
    () => anchored.filter(({ root }) => root.path === path && !("deleted" in root)),
    [anchored, path],
  );
  const unsent = useMemo(
    () =>
      drafts.filter(
        (draft) => draft.path === path && draft.version === version && draft.anchor !== null,
      ),
    [drafts, path, version],
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
  }, [active, get, revision, threads, unsent, adapter]);

  useEffect(() => {
    publishPlaces(path, places);
  }, [publishPlaces, path, places]);
  useEffect(() => () => publishPlaces(path, null), [publishPlaces, path]);

  const focus = useCallback(
    (location: AnchorLocation) => {
      location.element.scrollIntoView({
        block: "center",
        behavior: reducedMotion ? "auto" : "smooth",
      });
      flash({ version, range: location.range });
    },
    [flash, reducedMotion, version],
  );

  useEffect(() => {
    setCssHighlight(COMMENT_FOCUS_HIGHLIGHT, flashed?.version === version ? [flashed.range] : []);
  }, [flashed, version]);
  useEffect(
    () => () => {
      setCssHighlight(COMMENT_FOCUS_HIGHLIGHT, []);
      setCssHighlight(COMMENT_DRAFT_HIGHLIGHT, []);
    },
    [],
  );

  useEffect(() => {
    if (!reveal || reveal.path !== path || reveal.version !== version) return;
    const index = settled() ? get() : null;
    if (!index) return;
    if (!reveal.anchor) return consumeReveal();
    const place = adapter.locate(index, reveal.anchor);
    if (place.status !== "found") return;
    consumeReveal();
    focus(place.location);
  }, [reveal, path, version, get, settled, revision, adapter, consumeReveal, focus]);

  const offerInput: OfferInput<Index> = {
    get,
    revision,
    content,
    key,
    composing: composingRef,
  };

  return { path, frame, content, composingRef, offerActive, key, offerInput };
}

function SurfaceView<Index>({
  base,
  offers,
  contentClassName,
  children,
}: {
  base: ReturnType<typeof useSurfaceBase<Index>>;
  offers: Offer;
  contentClassName?: string;
  children: ReactNode;
}) {
  const draft = useAnchorDraft({ key: base.key, frame: base.frame, ...offers });
  const isComposing = draft.composing !== null;
  useLayoutEffect(() => {
    base.composingRef.current = isComposing;
  }, [base.composingRef, isComposing]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div ref={base.frame} className="relative min-h-full">
        <div ref={base.content} className={contentClassName} onClickCapture={offers.onContentClick}>
          {children}
        </div>
        {base.offerActive && <DraftAffordance draft={draft} path={base.path} />}
      </div>
    </div>
  );
}
