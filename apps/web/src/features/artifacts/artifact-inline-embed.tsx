import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { isAppError } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useArtifactLink } from "./artifact-beside-chat";
import {
  InlineEmbedControls,
  InlineEmbedFallback,
  InlineEmbedLoadingOverlay,
  InlineEmbedLoadingShell,
} from "./artifact-inline-embed-chrome";
import { ArtifactPreviewFrame } from "./artifact-preview-frame";
import { PageConfirmDialog } from "./artifact-page-confirm";
import { PageErrorBanner, usePageErrorReport } from "./artifact-page-notices";
import type { PageFrameSize, PageSuggestHandler } from "./artifact-page-bridge";
import {
  INLINE_DEFAULT_HEIGHT_PX,
  nextInlineFrameHeight,
  type InlineHeightState,
} from "./artifact-page-theme";
import { ARTIFACTS_KEY, type ArtifactCard } from "./artifact-queries";
import { loadArtifactSandboxLink } from "./artifact-sandbox.functions";
import type { InlineSandboxLink, PooledInlineFrame } from "./inline-embed-pool";
import { useInlineEmbedPool } from "./inline-embed-pool-context";
import { useArtifactPageBridge } from "./use-artifact-page-bridge";
import { useManagedInlineFrame } from "./use-managed-inline-frame";

const LOADING_LABEL_DELAY_MS = 140;
const POST_LOAD_REVEAL_MS = 2_000;
const LOAD_TIMEOUT_MS = 10_000;

const inlineSandboxLinkQuery = (
  slotId: string,
  artifactId: string,
  version: number | undefined,
  resolvedVersion: number,
) => ({
  queryKey: [...ARTIFACTS_KEY, "inline-sandbox", slotId, artifactId, resolvedVersion],
  queryFn: () => loadArtifactSandboxLink({ data: { artifactId, version } }),
  staleTime: 0,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export function ArtifactInlineEmbed({
  card,
  version,
  selectionActive = false,
}: {
  card: ArtifactCard;
  version?: number;
  selectionActive?: boolean;
}) {
  const slotId = useId();
  const pool = useInlineEmbedPool();
  const hostRef = useRef<HTMLDivElement>(null);
  const linkTo = useArtifactLink();
  const router = useRouter();
  const coarse = useCoarsePointer();
  const resolvedVersion = version ?? card.currentVersion;
  const heightKey = `${card.id}:${resolvedVersion}`;
  const title = card.title || m.doc_untitled();

  const initialHeightState = (): InlineHeightState => {
    const cached = pool.cachedHeight(heightKey);
    return {
      height: cached ?? INLINE_DEFAULT_HEIGHT_PX,
      settled: cached !== undefined,
      hostWidth: null,
    };
  };
  const heightStateRef = useRef<InlineHeightState>(initialHeightState());
  const [height, setHeight] = useState(() => heightStateRef.current.height);

  useEffect(() => {
    const cached = pool.cachedHeight(heightKey);
    const width = hostRef.current?.clientWidth || null;
    const next: InlineHeightState = {
      height: cached ?? INLINE_DEFAULT_HEIGHT_PX,
      settled: cached !== undefined,
      hostWidth: width,
    };
    heightStateRef.current = next;
    setHeight(next.height);
  }, [pool, heightKey]);

  const expandedRef = useRef(false);
  const inViewRef = useRef(false);
  const mountedRef = useRef(true);

  const reportVisibility = useEffectEvent((visible: boolean) => {
    pool.setVisible(slotId, visible, heightKey);
  });

  const handleExpandedChange = useCallback(
    (nextExpanded: boolean) => {
      if (expandedRef.current === nextExpanded) return;
      expandedRef.current = nextExpanded;
      if (!mountedRef.current) return;
      pool.setVisible(slotId, nextExpanded || inViewRef.current, heightKey);
    },
    [pool, slotId, heightKey],
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inViewRef.current = false;
      expandedRef.current = false;
      pool.release(slotId);
    };
  }, [pool, slotId]);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    if (typeof IntersectionObserver !== "function") {
      inViewRef.current = true;
      reportVisibility(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry || !mountedRef.current) return;
        inViewRef.current = entry.isIntersecting;
        reportVisibility(entry.isIntersecting || expandedRef.current);
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [pool, slotId]);

  const active = useSyncExternalStore(
    pool.subscribe,
    () => pool.isActive(slotId),
    () => false,
  );

  const openProps = linkTo(card.id);
  const handleOpenPanel = useCallback(() => {
    void router.navigate(openProps);
  }, [router, openProps]);

  const handleSize = useCallback(
    (size: PageFrameSize) => {
      const hostWidth = hostRef.current?.clientWidth || null;
      const next = nextInlineFrameHeight(heightStateRef.current, size.height, hostWidth);
      heightStateRef.current = next;
      if (!next.settled) return;
      pool.rememberHeight(heightKey, next.height);
      setHeight(next.height);
    },
    [pool, heightKey],
  );

  return (
    <div
      ref={hostRef}
      data-artifact-inline-embed={card.id}
      onClick={(event) => {
        if (!selectionActive) event.stopPropagation();
      }}
      className="group/embed relative w-full max-w-[56rem] rounded-lg"
    >
      {!active ? (
        <div
          style={{ height: `${height}px` }}
          className="relative w-full rounded-lg bg-transparent"
        />
      ) : (
        <ActiveInlineEmbed
          key={heightKey}
          slotId={slotId}
          heightKey={heightKey}
          card={card}
          version={version}
          resolvedVersion={resolvedVersion}
          title={title}
          height={height}
          coarse={coarse}
          selectionActive={selectionActive}
          openProps={openProps}
          onOpenPanel={handleOpenPanel}
          onSizeChanged={handleSize}
          onExpandedChange={handleExpandedChange}
        />
      )}
    </div>
  );
}

function ActiveInlineEmbed({
  slotId,
  heightKey,
  card,
  version,
  resolvedVersion,
  title,
  height,
  coarse,
  selectionActive,
  openProps,
  onOpenPanel,
  onSizeChanged,
  onExpandedChange,
}: {
  slotId: string;
  heightKey: string;
  card: ArtifactCard;
  version: number | undefined;
  resolvedVersion: number;
  title: string;
  height: number;
  coarse: boolean;
  selectionActive: boolean;
  openProps: ReturnType<ReturnType<typeof useArtifactLink>>;
  onOpenPanel: () => void;
  onSizeChanged: (size: PageFrameSize) => void;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const pool = useInlineEmbedPool();
  const [reusedFrame, setReusedFrame] = useState<PooledInlineFrame | null>(null);
  const [checkedPool, setCheckedPool] = useState(() => !pool.hasParkedFrame(heightKey));
  const claimAttemptedRef = useRef(false);
  const claimedRef = useRef<PooledInlineFrame | null>(null);

  useLayoutEffect(() => {
    if (checkedPool || claimAttemptedRef.current) return;
    claimAttemptedRef.current = true;
    const claimed = pool.claimParkedFrame(slotId, heightKey);
    if (claimed) {
      claimedRef.current = claimed;
      setReusedFrame(claimed);
    }
    setCheckedPool(true);
  }, [checkedPool, pool, slotId, heightKey]);

  useLayoutEffect(
    () => () => {
      const pending = claimedRef.current;
      if (!pending) return;
      claimedRef.current = null;
      pool.releaseClaimedIfUnattached(pending);
    },
    [pool],
  );

  const link = useQuery({
    ...inlineSandboxLinkQuery(slotId, card.id, version, resolvedVersion),
    enabled: checkedPool && reusedFrame === null,
  });
  const refetchLink = link.refetch;
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (reusedFrame) return;
    setShowLoading(false);
    const timer = window.setTimeout(() => setShowLoading(true), LOADING_LABEL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [card.id, resolvedVersion, reusedFrame]);

  const loadingLabel = m.doc_embed_loading_version({
    title,
    version: reusedFrame?.version ?? link.data?.version ?? resolvedVersion,
  });

  const handleReload = useCallback(() => {
    if (reusedFrame) {
      claimedRef.current = null;
      reusedFrame.blocked = true;
      pool.discardFrame(reusedFrame);
      setReusedFrame(null);
      return;
    }
    void refetchLink();
  }, [reusedFrame, pool, refetchLink]);

  if (!reusedFrame && !checkedPool) {
    return (
      <div
        style={{ height: `${height}px` }}
        className="relative w-full rounded-lg bg-transparent"
      />
    );
  }

  if (!reusedFrame && link.isError) {
    const off = isAppError(link.error) && link.error.errorId === "artifact-sandbox-off";
    return (
      <InlineEmbedFallback
        message={off ? m.doc_page_preview_off() : m.doc_page_preview_failed()}
        retryLabel={off ? undefined : m.doc_page_preview_retry()}
        retrying={link.isFetching}
        onRetry={off ? undefined : handleReload}
        openProps={openProps}
      />
    );
  }

  const activeLink = reusedFrame?.link ?? link.data;
  if (!activeLink) {
    return <InlineEmbedLoadingShell height={height} showLabel={showLoading} label={loadingLabel} />;
  }

  return (
    <InlineEmbedFrame
      key={activeLink.url}
      slotId={slotId}
      heightKey={heightKey}
      reusedFrame={reusedFrame ?? undefined}
      link={activeLink}
      artifactId={card.id}
      title={title}
      entryPath={card.entryPath}
      height={height}
      coarse={coarse}
      selectionActive={selectionActive}
      retrying={reusedFrame ? false : link.isFetching}
      showLoading={reusedFrame ? false : showLoading}
      loadingLabel={loadingLabel}
      openProps={openProps}
      onOpenPanel={onOpenPanel}
      onSizeChanged={onSizeChanged}
      onExpandedChange={onExpandedChange}
      onReload={handleReload}
    />
  );
}

function InlineEmbedFrame({
  slotId,
  heightKey,
  reusedFrame,
  link,
  artifactId,
  title,
  entryPath,
  height,
  coarse,
  selectionActive,
  retrying,
  showLoading,
  loadingLabel,
  openProps,
  onOpenPanel,
  onSizeChanged,
  onExpandedChange,
  onReload,
}: {
  slotId: string;
  heightKey: string;
  reusedFrame?: PooledInlineFrame;
  link: InlineSandboxLink;
  artifactId: string;
  title: string;
  entryPath: string;
  height: number;
  coarse: boolean;
  selectionActive: boolean;
  retrying: boolean;
  showLoading: boolean;
  loadingLabel: string;
  openProps: ReturnType<ReturnType<typeof useArtifactLink>>;
  onOpenPanel: () => void;
  onSizeChanged: (size: PageFrameSize) => void;
  onExpandedChange: (expanded: boolean) => void;
  onReload: () => void;
}) {
  const pool = useInlineEmbedPool();
  const initialReady = Boolean(reusedFrame?.ready);
  const useManagedFrame = reusedFrame !== undefined || pool.canParkFrames();
  const frame = useRef<HTMLIFrameElement>(reusedFrame?.iframe ?? null);
  const suggestions = useRef<PageSuggestHandler | null>(null);
  const origin = useMemo(() => new URL(link.url).origin, [link.url]);
  const artifact = useMemo(
    () => ({ id: artifactId, title, version: link.version, entryPath }),
    [artifactId, title, link.version, entryPath],
  );

  const [phase, setPhase] = useState<"loading" | "ready" | "timeout">(
    initialReady ? "ready" : "loading",
  );
  const [expanded, setExpanded] = useState(false);
  const acceptInlineSizeRef = useRef(true);
  if (expanded) acceptInlineSizeRef.current = false;
  const wasExpandedRef = useRef(false);
  const initializedRef = useRef(initialReady);
  const sizedRef = useRef(initialReady);
  const loadedRef = useRef(initialReady);
  const revealedRef = useRef(initialReady);
  const revealRaf = useRef<number | null>(null);
  const collapseRaf = useRef<number | null>(null);
  const pooledEntryRef = useRef<PooledInlineFrame | null>(reusedFrame ?? null);

  const reveal = useCallback(() => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    revealRaf.current = requestAnimationFrame(() => {
      revealRaf.current = null;
      if (pooledEntryRef.current) pooledEntryRef.current.ready = true;
      setPhase("ready");
    });
  }, []);

  const maybeReveal = useCallback(() => {
    if (initializedRef.current && sizedRef.current) reveal();
  }, [reveal]);

  const handleInitialized = useCallback(() => {
    initializedRef.current = true;
    maybeReveal();
  }, [maybeReveal]);

  const handleSizeChanged = useCallback(
    (size: PageFrameSize) => {
      if (acceptInlineSizeRef.current) onSizeChanged(size);
      if (size.height > 0) {
        sizedRef.current = true;
        maybeReveal();
      }
    },
    [onSizeChanged, maybeReveal],
  );

  const { bridge, confirmation, error, dismissError, blocked } = useArtifactPageBridge({
    frame,
    origin,
    viewer: link.viewer,
    level: link.level,
    displayMode: "inline",
    expanded,
    artifact,
    suggestions,
    onInitialized: handleInitialized,
    onSizeChanged: handleSizeChanged,
  });

  const askAgent = usePageErrorReport({
    version: link.version,
    error,
    frame,
    dismissError,
  });

  useEffect(() => {
    if (initialReady) return;
    const timeoutTimer = window.setTimeout(() => {
      if (revealedRef.current) return;
      if (loadedRef.current) reveal();
      else setPhase("timeout");
    }, LOAD_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timeoutTimer);
    };
  }, [initialReady, reveal]);

  useEffect(() => {
    if (selectionActive && expanded) setExpanded(false);
  }, [selectionActive, expanded]);

  useEffect(() => {
    onExpandedChange(expanded);
    if (expanded) {
      acceptInlineSizeRef.current = false;
      if (collapseRaf.current !== null) {
        cancelAnimationFrame(collapseRaf.current);
        collapseRaf.current = null;
      }
      if (!wasExpandedRef.current) bridge.notifyHostContext();
    } else if (wasExpandedRef.current) {
      collapseRaf.current = requestAnimationFrame(() => {
        collapseRaf.current = null;
        acceptInlineSizeRef.current = true;
        bridge.notifyHostContext();
      });
    }
    wasExpandedRef.current = expanded;
  }, [expanded, onExpandedChange, bridge]);

  useEffect(() => () => onExpandedChange(false), [onExpandedChange]);

  const postLoadTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (postLoadTimer.current !== null) window.clearTimeout(postLoadTimer.current);
      if (revealRaf.current !== null) cancelAnimationFrame(revealRaf.current);
      if (collapseRaf.current !== null) cancelAnimationFrame(collapseRaf.current);
    },
    [],
  );

  const handleFrameLoad = useCallback(() => {
    loadedRef.current = true;
    if (revealedRef.current) return;
    if (postLoadTimer.current !== null) window.clearTimeout(postLoadTimer.current);
    postLoadTimer.current = window.setTimeout(() => {
      if (!revealedRef.current) reveal();
    }, POST_LOAD_REVEAL_MS);
  }, [reveal]);

  const frameUnavailable = blocked || phase === "timeout";
  useLayoutEffect(() => {
    if (blocked && pooledEntryRef.current) {
      pooledEntryRef.current.blocked = true;
    }
  }, [blocked]);
  const frameSlotRef = useManagedInlineFrame({
    enabled: useManagedFrame,
    unavailable: frameUnavailable,
    pool,
    slotId,
    heightKey,
    artifactId,
    title,
    link,
    frameRef: frame,
    pooledEntryRef,
    onLoad: handleFrameLoad,
    onReload,
    shouldDiscard: () => blocked || bridge.hasActiveWatches(),
  });

  useEffect(() => {
    if (!initialReady || frameUnavailable) return;
    bridge.notifyHostContext();
  }, [initialReady, frameUnavailable, bridge]);

  if (blocked) {
    return (
      <InlineEmbedFallback
        message={m.doc_page_expired_title()}
        detail={m.doc_page_expired_body()}
        retryLabel={m.doc_page_expired_reload()}
        retrying={retrying}
        onRetry={onReload}
        openProps={openProps}
      />
    );
  }

  if (phase === "timeout") {
    return (
      <InlineEmbedFallback
        message={m.doc_embed_timeout()}
        retryLabel={m.doc_page_preview_retry()}
        retrying={retrying}
        onRetry={onReload}
        openProps={openProps}
      />
    );
  }

  const ready = phase === "ready";

  return (
    <div style={expanded ? { height: `${height}px` } : undefined} className="relative w-full">
      <ArtifactPreviewFrame
        full={expanded}
        onExit={() => setExpanded(false)}
        aria-label={title}
        aria-busy={!ready}
        className={cn(
          "overflow-hidden",
          expanded
            ? "fixed inset-0 flex size-full flex-col bg-primary"
            : "relative block w-full rounded-lg bg-transparent",
        )}
      >
        {error !== null && (
          <PageErrorBanner
            className={expanded ? "mx-4 mt-3 shrink-0" : "mb-2 shrink-0"}
            onAskAgent={() => void askAgent()}
            onClose={dismissError}
          />
        )}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-secondary/40 transition-opacity duration-200",
            ready ? "opacity-0" : "opacity-100",
          )}
        >
          <div className="h-full rounded-full bg-brand-solid motion-safe:inline-embed-progress" />
        </div>
        <div
          style={expanded ? undefined : { height: `${height}px` }}
          className={cn(
            "relative w-full",
            expanded ? "min-h-0 flex-1" : "transition-[height] duration-200 ease-out",
          )}
        >
          <div
            ref={useManagedFrame ? frameSlotRef : undefined}
            className={cn(
              "size-full transition-opacity duration-150",
              ready ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {!useManagedFrame && (
              <iframe
                ref={frame}
                aria-label={title}
                src={link.url}
                sandbox="allow-scripts allow-same-origin"
                allow="clipboard-read 'none'; clipboard-write 'none'"
                referrerPolicy="no-referrer"
                onLoad={handleFrameLoad}
                className="block h-full w-full border-0 bg-transparent"
              />
            )}
          </div>
          {!ready && <InlineEmbedLoadingOverlay showLabel={showLoading} label={loadingLabel} />}
          {selectionActive && !expanded && (
            <div aria-hidden="true" className="absolute inset-0 z-20" />
          )}
        </div>
        {(expanded || (ready && !selectionActive)) && (
          <InlineEmbedControls
            coarse={coarse}
            expanded={expanded}
            onOpenPanel={onOpenPanel}
            onToggleExpand={() => setExpanded((current) => !current)}
          />
        )}
        <PageConfirmDialog confirmation={confirmation} title={title} />
      </ArtifactPreviewFrame>
    </div>
  );
}
