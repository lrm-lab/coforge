import { useQuery } from "@tanstack/react-query";
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
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactIcon } from "./artifact-parts";
import { VersionMenu } from "./artifact-version-menu";

export const ARTIFACT_TITLE_ID = "artifact-page-title";

export type ArtifactPaneControls = { full: boolean; onToggleFull: () => void; onClose: () => void };

export type ArtifactHome = { kind: "channel" | "dm" | "workspace"; conversationId: string | null };

export function ArtifactPageHeader({
  artifactId,
  entryPath,
  title,
  shownVersion,
  home,
  pills,
  onChooseVersion,
  onFind,
  onCopyLink,
  menu,
  pane,
}: {
  artifactId: string;
  entryPath: string | undefined;
  title: string;
  shownVersion?: number;
  home: ArtifactHome | undefined;
  pills?: ReactNode;
  onChooseVersion: (version: number) => void;
  onFind?: () => void;
  onCopyLink?: () => void;
  menu?: ReactNode;
  pane?: ArtifactPaneControls;
}) {
  const Title = pane ? "h2" : "h1";
  return (
    <header
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-secondary py-2 sm:min-h-14 sm:flex-nowrap",
        pane ? "pr-2 pl-4" : "px-3 sm:px-4",
      )}
    >
      {!pane && <BackToHome home={home} />}
      {entryPath === undefined ? (
        <Skeleton className="h-4 w-40" />
      ) : (
        <>
          <ArtifactIcon entryPath={entryPath} size="sm" />
          <Title
            id={ARTIFACT_TITLE_ID}
            className="min-w-0 truncate text-sm font-semibold text-primary"
          >
            {title}
          </Title>
          {shownVersion !== undefined && (
            <Dropdown.Root>
              <AriaButton
                aria-label={m.av_version_switch({ version: shownVersion })}
                className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-tertiary tabular-nums outline-focus-ring ring-1 ring-secondary ring-inset hover:bg-primary_hover focus-visible:outline-2"
              >
                v{shownVersion}
                <ChevronDown aria-hidden="true" className="size-3" />
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
      <span className="flex-1 max-sm:order-1" />
      <div className="flex min-w-0 items-center gap-1.5 max-sm:order-last max-sm:basis-full sm:order-none">
        {pills}
      </div>
      <div className="flex shrink-0 items-center gap-1 max-sm:order-2">
        {onFind && (
          <ButtonUtility
            icon={SearchLg}
            size="sm"
            color="tertiary"
            tooltip={m.doc_page_find()}
            className="max-sm:hidden"
            onClick={onFind}
          />
        )}
        {onCopyLink && (
          <ButtonUtility
            icon={Link01}
            size="sm"
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
              size="sm"
              color="tertiary"
              tooltip={pane.full ? m.doc_exit_fullscreen() : m.doc_fullscreen()}
              className="max-md:hidden"
              onClick={pane.onToggleFull}
            />
            <ButtonUtility
              icon={XClose}
              size="sm"
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

export function useHomeName(home: ArtifactHome | undefined): string | undefined {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channelId = home?.kind === "channel" ? home.conversationId : null;
  const channels = useQuery({ ...channelNamesQuery(workspaceId), enabled: channelId !== null });
  const name = channelId ? channels.data?.find((c) => c.id === channelId)?.name : undefined;
  return name ? `#${name}` : undefined;
}

function BackToHome({ home }: { home: ArtifactHome | undefined }) {
  const workspaceSlug = useWorkspaceSlug();
  const toWorkspace = home !== undefined && (!home.conversationId || home.kind === "workspace");
  const homeName = useHomeName(home);
  const channel = home?.kind === "channel" && home.conversationId ? home.conversationId : null;
  const label = toWorkspace ? (
    m.doc_back_to_workspace()
  ) : channel && homeName ? (
    <ChannelPlace id={channel} name={homeName.replace(/^#/, "")} />
  ) : (
    (homeName ?? m.doc_back())
  );
  const className =
    "flex min-w-0 shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-tertiary outline-focus-ring hover:bg-primary_hover hover:text-secondary focus-visible:outline-2";
  const inner = (
    <>
      <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
      <span className="max-w-40 truncate max-sm:sr-only">{label}</span>
    </>
  );
  if (!home?.conversationId || home.kind === "workspace")
    return (
      <Link to="/w/$workspaceSlug" params={{ workspaceSlug }} className={className}>
        {inner}
      </Link>
    );
  const target =
    home.kind === "channel" ? { channelId: home.conversationId } : { dmId: home.conversationId };
  return (
    <Link {...conversationRoute(target, workspaceSlug)} className={className}>
      {inner}
    </Link>
  );
}
