import type { MouseEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Browser, Maximize01, Minimize01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { useArtifactLink } from "./artifact-beside-chat";

export function InlineEmbedLoadingShell({
  height,
  showLabel,
  label,
}: {
  height: number;
  showLabel: boolean;
  label: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      style={{ height: `${height}px` }}
      className="relative w-full overflow-hidden rounded-lg bg-transparent"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-secondary/40"
      >
        <div className="h-full rounded-full bg-brand-solid motion-safe:inline-embed-progress" />
      </div>
      <InlineEmbedLoadingOverlay showLabel={showLabel} label={label} />
    </div>
  );
}

export function InlineEmbedLoadingOverlay({
  showLabel,
  label,
}: {
  showLabel: boolean;
  label: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-transparent px-4"
    >
      {showLabel && (
        <p className="min-w-0 max-w-full truncate text-center text-xs text-tertiary tabular-nums">
          {label}
        </p>
      )}
    </div>
  );
}

export function InlineEmbedControls({
  coarse,
  expanded,
  onOpenPanel,
  onToggleExpand,
}: {
  coarse: boolean;
  expanded: boolean;
  onOpenPanel: () => void;
  onToggleExpand: () => void;
}) {
  const buttonClass =
    "rounded-md border border-secondary/60 bg-primary/90 p-1 *:data-icon:size-3.5";
  return (
    <div
      className={cn(
        "absolute top-1.5 right-1.5 z-10 flex items-center gap-1 transition-opacity duration-150",
        expanded || coarse
          ? "opacity-90"
          : "opacity-0 group-hover/embed:opacity-100 group-focus-within/embed:opacity-100 [@media(hover:none)]:opacity-90",
      )}
    >
      {!expanded && (
        <ButtonUtility
          data-artifact-open-panel=""
          icon={ArrowUpRight}
          size="xs"
          color="tertiary"
          tooltip={m.doc_embed_open_panel()}
          className={buttonClass}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            onOpenPanel();
          }}
        />
      )}
      <ButtonUtility
        data-artifact-expand=""
        icon={expanded ? Minimize01 : Maximize01}
        size="xs"
        color="tertiary"
        tooltip={expanded ? m.doc_exit_fullscreen() : m.doc_fullscreen()}
        className={buttonClass}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          onToggleExpand();
        }}
      />
    </div>
  );
}

export function InlineEmbedFallback({
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
