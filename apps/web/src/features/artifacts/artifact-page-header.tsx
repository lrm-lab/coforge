import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, Maximize01, Minimize01, XClose } from "@untitledui/icons";
import { Button as AriaButton, Focusable } from "react-aria-components";
import type { ReactNode, RefObject } from "react";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import { PRESSABLE_CHIP_CLASS } from "#src/features/conversations/review-chrome";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { homeConversationOf, homeLinkProps, type ArtifactHome } from "./artifact-home";
import { RecentArtifactsMenu } from "./artifact-recent-menu";
import { useArrivedFromGallery } from "./artifact-search";
import { VersionMenu } from "./artifact-version-menu";

export const ARTIFACT_TITLE_ID = "artifact-page-title";

export type ArtifactPaneControls = {
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
  conversationId?: string;
  onSwitchArtifact?: (artifactId: string) => void;
};

export type ArtifactOverlayControls = {
  onClose: () => void;
};

export function ArtifactPageHeader({
  artifactId,
  entryPath,
  title,
  shownVersion,
  titleStatus,
  home,
  homeName,
  detailsTrigger,
  mobileMeta,
  titleContainerRef,
  onChooseVersion,
  comments,
  share,
  menu,
  pane,
  overlay,
}: {
  artifactId: string;
  entryPath: string | undefined;
  title: string;
  shownVersion?: number;
  titleStatus?: ReactNode;
  home: ArtifactHome | undefined;
  homeName: string | undefined;
  detailsTrigger?: ReactNode;
  mobileMeta?: ReactNode;
  titleContainerRef?: RefObject<HTMLDivElement | null>;
  onChooseVersion: (version: number) => void;
  comments?: ReactNode;
  share?: ReactNode;
  menu?: ReactNode;
  pane?: ArtifactPaneControls;
  overlay?: ArtifactOverlayControls;
}) {
  const Title = pane || overlay ? "h2" : "h1";
  const hasRecentSwitcher = Boolean(pane?.conversationId && pane.onSwitchArtifact);

  return (
    <header
      className={cn(
        "@container/header flex min-h-12 shrink-0 items-center gap-1.5 border-b border-secondary py-1.5 sm:gap-2",
        pane ? "pr-2 pl-4" : "px-3 sm:px-4",
      )}
    >
      {!pane && !overlay && <BackToHome home={home} homeName={homeName} />}
      {entryPath === undefined ? (
        <span className="inline-flex min-w-0 flex-1 sm:flex-initial">
          <Skeleton className="h-4 w-40" />
        </span>
      ) : (
        <div
          ref={titleContainerRef}
          className="flex min-w-0 flex-1 flex-col sm:flex-initial sm:flex-row sm:items-center sm:gap-1.5"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {hasRecentSwitcher && pane?.conversationId && pane.onSwitchArtifact ? (
              <RecentArtifactsMenu
                conversationId={pane.conversationId}
                artifactId={artifactId}
                titleId={ARTIFACT_TITLE_ID}
                title={title}
                onSwitch={pane.onSwitchArtifact}
              />
            ) : detailsTrigger ? (
              detailsTrigger
            ) : (
              <Tooltip title={title} placement="bottom start">
                <Focusable>
                  <Title
                    id={ARTIFACT_TITLE_ID}
                    tabIndex={0}
                    className="min-w-0 truncate rounded-sm text-sm font-medium text-primary outline-focus-ring focus-visible:outline-2"
                  >
                    {title}
                  </Title>
                </Focusable>
              </Tooltip>
            )}
            {shownVersion !== undefined && (
              <Dropdown.Root>
                <AriaButton
                  aria-label={m.av_version_switch({ version: shownVersion })}
                  className={cn(
                    PRESSABLE_CHIP_CLASS,
                    "relative h-8 shrink-0 rounded-lg px-2 tabular-nums any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-2",
                  )}
                >
                  v{shownVersion}
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </AriaButton>
                <Dropdown.Popover
                  title={m.av_versions()}
                  placement="bottom start"
                  className="[--cascade-menu-max-width:min(21rem,calc(100vw-1.5rem))] [--cascade-menu-width:min(21rem,calc(100vw-1.5rem))]"
                >
                  <VersionMenu
                    artifactId={artifactId}
                    shown={shownVersion}
                    onChoose={onChooseVersion}
                  />
                </Dropdown.Popover>
              </Dropdown.Root>
            )}
            {titleStatus}
          </div>
          {mobileMeta && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:hidden">
              {mobileMeta}
            </div>
          )}
        </div>
      )}
      <span className="hidden flex-1 sm:block" />
      <div className="flex shrink-0 items-center gap-1">
        {comments}
        {share}
        {menu}
        {(comments || share || menu) && (overlay || pane) && (
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border-secondary" />
        )}
        {overlay && (
          <ButtonUtility
            icon={XClose}
            size="xs"
            color="tertiary"
            tooltip={m.doc_close()}
            className="size-8"
            onClick={overlay.onClose}
          />
        )}
        {pane && (
          <>
            <ButtonUtility
              data-artifact-expand=""
              icon={pane.full ? Minimize01 : Maximize01}
              size="xs"
              color="tertiary"
              tooltip={pane.full ? m.doc_exit_fullscreen() : m.doc_fullscreen()}
              className="size-8"
              onClick={pane.onToggleFull}
            />
            <ButtonUtility
              icon={XClose}
              size="xs"
              color="tertiary"
              tooltip={m.doc_close()}
              className="size-8"
              onClick={pane.onClose}
            />
          </>
        )}
      </div>
    </header>
  );
}

function BackToHome({
  home,
  homeName,
}: {
  home: ArtifactHome | undefined;
  homeName: string | undefined;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const fromGallery = useArrivedFromGallery();
  const channel = home?.kind === "channel" ? homeConversationOf(home) : undefined;
  const label = fromGallery ? (
    m.navigation_artifacts()
  ) : home !== undefined && !homeConversationOf(home) ? (
    m.doc_back_to_workspace()
  ) : channel && homeName ? (
    <ChannelPlace id={channel} name={homeName.replace(/^#/, "")} />
  ) : (
    (homeName ?? m.doc_back())
  );
  const target = fromGallery
    ? ({ to: "/w/$workspaceSlug/artifacts", params: { workspaceSlug } } as const)
    : homeLinkProps(home, workspaceSlug);
  return (
    <Link
      {...target}
      className="relative flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5"
    >
      <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
      <span className="max-w-40 truncate max-sm:sr-only">{label}</span>
    </Link>
  );
}
