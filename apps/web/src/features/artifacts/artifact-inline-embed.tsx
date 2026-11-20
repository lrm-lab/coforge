import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Browser, Maximize01, Minimize01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Skeleton } from "#src/components/ui/skeleton";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { isAppError } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useArtifactLink } from "./artifact-beside-chat";
import { ArtifactPreviewFrame } from "./artifact-preview-frame";
import { PageConfirmDialog } from "./artifact-page-confirm";
import type { PageFrameSize, PageSuggestHandler } from "./artifact-page-bridge";
import {
  INLINE_DEFAULT_HEIGHT_PX,
  nextInlineFrameHeight,
  type InlineHeightState,
} from "./artifact-page-theme";
import { ARTIFACTS_KEY, type ArtifactCard } from "./artifact-queries";
import { loadArtifactSandboxLink } from "./artifact-sandbox.functions";
import { useInlineEmbedPool } from "./inline-embed-pool-context";
import { useArtifactPageBridge } from "./use-artifact-page-bridge";

const SKELETON_DELAY_MS = 140;
const POST_LOAD_REVEAL_MS = 2_000;
const LOAD_TIMEOUT_MS = 10_000;

type SandboxLink = Awaited<ReturnType<typeof loadArtifactSandboxLink>>;

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

  const handleExpandedChange = useCallback(
    (nextExpanded: boolean) => {
      expandedRef.current = nextExpanded;
      pool.setVisible(slotId, nextExpanded || inViewRef.current);
    },
    [pool, slotId],
  );

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    if (typeof IntersectionObserver !== "function") {
      inViewRef.current = true;
      pool.setVisible(slotId, true);
      return () => pool.release(slotId);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        inViewRef.current = entry.isIntersecting;
        pool.setVisible(slotId, entry.isIntersecting || expandedRef.current);
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      pool.release(slotId);
    };
  }, [pool, slotId]);

  const active = useSyncExternalStore(
    pool.subscribe,
    () => pool.isActive(slotId),
    () => false,
  );

  const openProps = linkTo(card.id);

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
          slotId={slotId}
          card={card}
          version={version}
          resolvedVersion={resolvedVersion}
          title={title}
          height={height}
          coarse={coarse}
          selectionActive={selectionActive}
          openProps={openProps}
          onSizeChanged={handleSize}
          onExpandedChange={handleExpandedChange}
        />
      )}
    </div>
  );
}

function ActiveInlineEmbed({
  slotId,
  card,
  version,
  resolvedVersion,
  title,
  height,
  coarse,
  selectionActive,
  openProps,
  onSizeChanged,
  onExpandedChange,
}: {
  slotId: string;
  card: ArtifactCard;
  version: number | undefined;
  resolvedVersion: number;
  title: string;
  height: number;
  coarse: boolean;
  selectionActive: boolean;
  openProps: ReturnType<ReturnType<typeof useArtifactLink>>;
  onSizeChanged: (size: PageFrameSize) => void;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const link = useQuery(inlineSandboxLinkQuery(slotId, card.id, version, resolvedVersion));

  const handleReload = useCallback(() => {
    void link.refetch();
  }, [link]);

  if (link.isError) {
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
  if (!link.data) return <InlineEmbedLoadingShell height={height} showSkeleton />;
  return (
    <InlineEmbedFrame
      key={link.data.url}
      link={link.data}
      artifactId={card.id}
      title={title}
      entryPath={card.entryPath}
      height={height}
      coarse={coarse}
      selectionActive={selectionActive}
      retrying={link.isFetching}
      openProps={openProps}
      onSizeChanged={onSizeChanged}
      onExpandedChange={onExpandedChange}
      onReload={handleReload}
    />
  );
}

function InlineEmbedFrame({
  link,
  artifactId,
  title,
  entryPath,
  height,
  coarse,
  selectionActive,
  retrying,
  openProps,
  onSizeChanged,
  onExpandedChange,
  onReload,
}: {
  link: SandboxLink;
  artifactId: string;
  title: string;
  entryPath: string;
  height: number;
  coarse: boolean;
  selectionActive: boolean;
  retrying: boolean;
  openProps: ReturnType<ReturnType<typeof useArtifactLink>>;
  onSizeChanged: (size: PageFrameSize) => void;
  onExpandedChange: (expanded: boolean) => void;
  onReload: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const suggestions = useRef<PageSuggestHandler | null>(null);
  const origin = useMemo(() => new URL(link.url).origin, [link.url]);
  const artifact = useMemo(
    () => ({ id: artifactId, title, version: link.version, entryPath }),
    [artifactId, title, link.version, entryPath],
  );

  const [phase, setPhase] = useState<"loading" | "ready" | "timeout">("loading");
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const acceptInlineSizeRef = useRef(true);
  if (expanded) acceptInlineSizeRef.current = false;
  const wasExpandedRef = useRef(false);
  const initializedRef = useRef(false);
  const sizedRef = useRef(false);
  const loadedRef = useRef(false);
  const revealedRef = useRef(false);
  const revealRaf = useRef<number | null>(null);
  const collapseRaf = useRef<number | null>(null);

  const reveal = useCallback(() => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    revealRaf.current = requestAnimationFrame(() => {
      revealRaf.current = null;
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

  const { bridge, confirmation, blocked } = useArtifactPageBridge({
    frame,
    origin,
    viewer: link.viewer,
    level: link.level,
    displayMode: "inline",
    artifact,
    suggestions,
    onInitialized: handleInitialized,
    onSizeChanged: handleSizeChanged,
  });

  useEffect(() => {
    const skeletonTimer = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    const timeoutTimer = window.setTimeout(() => {
      if (revealedRef.current) return;
      if (loadedRef.current) reveal();
      else setPhase("timeout");
    }, LOAD_TIMEOUT_MS);
    return () => {
      window.clearTimeout(skeletonTimer);
      window.clearTimeout(timeoutTimer);
    };
  }, [reveal]);

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
    } else if (wasExpandedRef.current) {
      collapseRaf.current = requestAnimationFrame(() => {
        collapseRaf.current = null;
        acceptInlineSizeRef.current = true;
        bridge.notifyTheme();
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
    <>
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
            <iframe
              ref={frame}
              aria-label={title}
              src={link.url}
              sandbox="allow-scripts allow-same-origin"
              allow="clipboard-read 'none'; clipboard-write 'none'"
              referrerPolicy="no-referrer"
              onLoad={handleFrameLoad}
              className={cn(
                "block h-full w-full border-0 bg-transparent transition-opacity duration-150",
                ready ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            />
            {!ready && <InlineEmbedLoadingOverlay showSkeleton={showSkeleton} />}
            {selectionActive && !expanded && (
              <div aria-hidden="true" className="absolute inset-0 z-20" />
            )}
          </div>
          {(expanded || (ready && !selectionActive)) && (
            <InlineEmbedControls
              coarse={coarse}
              expanded={expanded}
              onToggleExpand={() => setExpanded((current) => !current)}
            />
          )}
          <PageConfirmDialog confirmation={confirmation} title={title} />
        </ArtifactPreviewFrame>
      </div>
    </>
  );
}

function InlineEmbedLoadingShell({
  height,
  showSkeleton,
}: {
  height: number;
  showSkeleton: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={m.doc_embed_loading()}
      style={{ height: `${height}px` }}
      className="relative w-full overflow-hidden rounded-lg bg-transparent"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-secondary/40"
      >
        <div className="h-full rounded-full bg-brand-solid motion-safe:inline-embed-progress" />
      </div>
      <InlineEmbedLoadingOverlay showSkeleton={showSkeleton} />
    </div>
  );
}

function InlineEmbedLoadingOverlay({ showSkeleton }: { showSkeleton: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col justify-between rounded-lg bg-transparent p-3"
    >
      {showSkeleton && (
        <>
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-3.5 w-28 bg-quaternary/60 motion-safe:animate-pulse" />
            <Skeleton className="h-3.5 w-16 bg-quaternary/60 motion-safe:animate-pulse" />
          </div>
          <div className="flex flex-1 items-end gap-2 py-3">
            <Skeleton className="h-1/2 flex-1 bg-quaternary/60 motion-safe:animate-pulse" />
            <Skeleton className="h-3/4 flex-1 bg-quaternary/60 motion-safe:animate-pulse" />
            <Skeleton className="h-3/5 flex-1 bg-quaternary/60 motion-safe:animate-pulse" />
            <Skeleton className="h-5/6 flex-1 bg-quaternary/60 motion-safe:animate-pulse" />
            <Skeleton className="h-2/3 flex-1 bg-quaternary/60 motion-safe:animate-pulse" />
          </div>
          <Skeleton className="h-3 w-24 bg-quaternary/60 motion-safe:animate-pulse" />
        </>
      )}
    </div>
  );
}

function InlineEmbedControls({
  coarse,
  expanded,
  onToggleExpand,
}: {
  coarse: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute top-1.5 right-1.5 z-10 transition-opacity duration-150",
        expanded || coarse
          ? "opacity-90"
          : "opacity-0 group-hover/embed:opacity-100 group-focus-within/embed:opacity-100",
      )}
    >
      <ButtonUtility
        data-artifact-expand=""
        icon={expanded ? Minimize01 : Maximize01}
        size="xs"
        color="tertiary"
        tooltip={expanded ? m.doc_exit_fullscreen() : m.doc_fullscreen()}
        className="rounded-md border border-secondary/60 bg-secondary/45 p-1 backdrop-blur-xs *:data-icon:size-3.5"
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          onToggleExpand();
        }}
      />
    </div>
  );
}

function InlineEmbedFallback({
  message,
  detail,
  retryLabel,
  retrying = false,
  onRetry,
  openProps,
}: {
  message: string;
  detail?: string;
  retryLabel?: string;
  retrying?: boolean;
  onRetry?: () => void;
  openProps: ReturnType<ReturnType<typeof useArtifactLink>>;
}) {
  return (
    <div className="flex flex-col items-start gap-2.5 rounded-lg border border-secondary bg-transparent p-4">
      <div className="flex items-start gap-2.5">
        <Browser aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-quaternary" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-primary">{message}</p>
          {detail && <p className="text-xs text-tertiary">{detail}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && retryLabel && (
          <Button size="sm" color="secondary" isLoading={retrying} onPress={onRetry}>
            {retryLabel}
          </Button>
        )}
        <Link
          {...openProps}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-lg border border-secondary bg-transparent px-3 py-1.5 text-xs font-medium text-secondary transition-colors hover:bg-secondary/50 hover:text-primary focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          <span>{m.doc_embed_open_panel()}</span>
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
