import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  Link01,
  Maximize01,
  Minimize01,
  SearchLg,
  XClose,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import type { ReactNode } from "react";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Skeleton } from "#src/components/ui/skeleton";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { cn } from "#src/lib/utils";
import { PRESSABLE_CHIP_CLASS } from "#src/features/conversations/review-chrome";
import { m } from "#src/paraglide/messages";
import { homeConversationOf, homeLinkProps, type ArtifactHome } from "./artifact-home";
import { RecentArtifactsMenu } from "./artifact-recent-menu";
import { useArrivedFromGallery } from "./artifact-search";
import { VersionMenu } from "./artifact-version-menu";
import { ARTIFACT_TITLE_VT_NAME, useActiveArtifactTransitionId } from "./artifact-view-transition";

export const ARTIFACT_TITLE_ID = "artifact-page-title";

export type ArtifactPaneControls = {
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
  conversationId?: string;
  onSwitchArtifact?: (artifactId: string) => void;
};

export function ArtifactPageHeader({
  artifactId,
  entryPath,
  title,
  shownVersion,
  home,
  homeName,
  pills,
  onChooseVersion,
  onFind,
  onCopyLink,
  comments,
  menu,
  pane,
}: {
  artifactId: string;
  entryPath: string | undefined;
  title: string;
  shownVersion?: number;
  home: ArtifactHome | undefined;
  homeName: string | undefined;
  pills?: ReactNode;
  onChooseVersion: (version: number) => void;
  onFind?: () => void;
  onCopyLink?: () => void;
  comments?: ReactNode;
  menu?: ReactNode;
  pane?: ArtifactPaneControls;
}) {
  const Title = pane ? "h2" : "h1";
  const reduced = usePrefersReducedMotion();
  const activeTransitionId = useActiveArtifactTransitionId();
  const activeTitleTransition = !pane && !reduced && activeTransitionId === artifactId;
  return (
    <header
      className={cn(
        "@container/header flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-secondary py-1.5 sm:min-h-12 sm:flex-nowrap",
        pane ? "pr-2 pl-4" : "px-3 sm:px-4",
      )}
    >
      {!pane && <BackToHome home={home} homeName={homeName} />}
      {entryPath === undefined ? (
        <span
          style={activeTitleTransition ? { viewTransitionName: ARTIFACT_TITLE_VT_NAME } : undefined}
          className="inline-flex"
        >
          <Skeleton className="h-4 w-40" />
        </span>
      ) : (
        <>
          {pane?.conversationId && pane.onSwitchArtifact ? (
            <RecentArtifactsMenu
              conversationId={pane.conversationId}
              artifactId={artifactId}
              titleId={ARTIFACT_TITLE_ID}
              title={title}
              onSwitch={pane.onSwitchArtifact}
            />
          ) : (
            <Title
              id={ARTIFACT_TITLE_ID}
              style={
                activeTitleTransition ? { viewTransitionName: ARTIFACT_TITLE_VT_NAME } : undefined
              }
              className="min-w-0 truncate text-sm font-medium text-primary"
            >
              {title}
            </Title>
          )}
          {shownVersion !== undefined && (
            <Dropdown.Root>
              <AriaButton
                aria-label={m.av_version_switch({ version: shownVersion })}
                className={cn(PRESSABLE_CHIP_CLASS, "shrink-0 tabular-nums")}
              >
                v{shownVersion}
                <ChevronDown aria-hidden="true" className="size-3.5" />
              </AriaButton>
              <Dropdown.Popover placement="bottom start" className="w-72">
                <VersionMenu
                  artifactId={artifactId}
                  shown={shownVersion}
                  onChoose={onChooseVersion}
                />
              </Dropdown.Popover>
            </Dropdown.Root>
          )}
        </>
      )}
      <div className="flex min-w-0 items-center gap-1.5 max-sm:order-last max-sm:basis-full sm:@max-2xl/header:max-w-28">
        {pills}
      </div>
      <span className="flex-1 max-sm:order-1" />
      <div className="flex shrink-0 items-center gap-1 max-sm:order-2">
        {comments}
        {onFind && (
          <ButtonUtility
            icon={SearchLg}
            size="xs"
            color="tertiary"
            tooltip={m.doc_page_find()}
            className="max-sm:hidden"
            onClick={onFind}
          />
        )}
        {onCopyLink && (
          <ButtonUtility
            icon={Link01}
            size="xs"
            color="tertiary"
            tooltip={m.doc_copy_link()}
            className="max-sm:hidden"
            onClick={onCopyLink}
          />
        )}
        {menu}
        {pane && (
          <>
            <ButtonUtility
              icon={pane.full ? Minimize01 : Maximize01}
              size="xs"
              color="tertiary"
              tooltip={pane.full ? m.doc_exit_fullscreen() : m.doc_fullscreen()}
              className="max-md:hidden"
              onClick={pane.onToggleFull}
            />
            <ButtonUtility
              icon={XClose}
              size="xs"
              color="tertiary"
              tooltip={m.doc_close()}
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
      className="flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2"
    >
      <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
      <span className="max-w-40 truncate max-sm:sr-only">{label}</span>
    </Link>
  );
}
