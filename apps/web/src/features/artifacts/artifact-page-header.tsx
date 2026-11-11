import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  DotsHorizontal,
  LinkExternal01,
  Link01,
  Maximize01,
  Minimize01,
  Trash01,
  XClose,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
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
import { type ArtifactStatus, StatusLine } from "./artifact-pane-header";
import { ArtifactIcon } from "./artifact-parts";

/** The page's title, which names its `main`. */
export const ARTIFACT_TITLE_ID = "artifact-page-title";

/** An artifact beside its conversation's chat (Frank, 11-05): full screen and close in place of
 * the way back, as the chat is right there. */
export type ArtifactPaneControls = { full: boolean; onToggleFull: () => void; onClose: () => void };

/** Where an artifact lives, as its page's way back names it. */
export type ArtifactHome = { kind: "channel" | "dm" | "workspace"; conversationId: string | null };

/**
 * An artifact's page's header (task #514): the way back to its conversation, its kind, title and
 * state, then Share and more (copy link, open a web page in a tab of its own, delete).
 * Beside the chat it has no way back, and ends with full screen and close (`pane`).
 */
export function ArtifactPageHeader({
  kind,
  title,
  status,
  home,
  canDelete,
  shareIcon,
  onShare,
  onCopyLink,
  onOpenInTab,
  onDelete,
  pane,
}: {
  /** Undefined until the artifact is read: the header holds its place. */
  kind: string | undefined;
  title: string;
  status: ArtifactStatus;
  home: ArtifactHome | undefined;
  canDelete: boolean;
  /** The artifact's access level's icon on the Share button. */
  shareIcon?: typeof ArrowLeft;
  /** Absent until the artifact is read. */
  onShare?: () => void;
  onCopyLink?: () => void;
  onOpenInTab?: () => void;
  onDelete?: () => void;
  pane?: ArtifactPaneControls;
}) {
  const Title = pane ? "h2" : "h1";
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-2 border-b border-secondary",
        pane ? "pr-2 pl-4" : "px-3 sm:px-4",
      )}
    >
      {!pane && (
        <>
          <BackToHome home={home} />
          <span
            aria-hidden="true"
            className="h-5 w-px shrink-0 bg-border-secondary max-sm:hidden"
          />
        </>
      )}
      {kind === undefined ? (
        <Skeleton className="h-4 w-40" />
      ) : (
        <>
          <ArtifactIcon kind={kind} size="sm" />
          {/* Beside the chat, the conversation's page holds the page's own heading. */}
          <Title
            id={ARTIFACT_TITLE_ID}
            className="min-w-0 truncate text-sm font-semibold text-primary"
          >
            {title}
          </Title>
          <span className="max-sm:hidden">
            <StatusLine status={status} />
          </span>
        </>
      )}
      <span className="flex-1" />
      {onShare &&
        (pane ? (
          // Beside the chat the title needs the room: Share keeps its icon and its tooltip.
          <ButtonUtility
            icon={shareIcon}
            size="sm"
            color="tertiary"
            tooltip={m.doc_share()}
            onClick={onShare}
          />
        ) : (
          <Button size="sm" color="secondary" iconLeading={shareIcon} onClick={onShare}>
            {m.doc_share()}
          </Button>
        ))}
      {onCopyLink && (
        <Dropdown.Root>
          <ButtonUtility icon={DotsHorizontal} size="sm" color="tertiary" tooltip={m.doc_more()} />
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={m.doc_more()}
              onAction={(key) =>
                key === "delete" ? onDelete?.() : key === "tab" ? onOpenInTab?.() : onCopyLink()
              }
            >
              <Dropdown.Item id="copy" icon={Link01} label={m.doc_copy_link()} />
              {onOpenInTab && (
                <Dropdown.Item id="tab" icon={LinkExternal01} label={m.doc_open_in_tab()} />
              )}
              {canDelete && <Dropdown.Separator />}
              {canDelete && <Dropdown.Item id="delete" icon={Trash01} label={m.doc_delete()} />}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      )}
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
    </header>
  );
}

/** A channel home's name as the page says it ("#launch"); undefined for a DM or the Workspace. */
export function useHomeName(home: ArtifactHome | undefined): string | undefined {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channelId = home?.kind === "channel" ? home.conversationId : null;
  const channels = useQuery({ ...channelNamesQuery(workspaceId), enabled: channelId !== null });
  const name = channelId ? channels.data?.find((c) => c.id === channelId)?.name : undefined;
  return name ? `#${name}` : undefined;
}

/** Back to the conversation the artifact lives in: a channel by its name, a DM as "Back"; with no
 * conversation to go back to (one of the Workspace, or one read only through the Workspace
 * level, task #529), back to the Workspace. */
function BackToHome({ home }: { home: ArtifactHome | undefined }) {
  const workspaceSlug = useWorkspaceSlug();
  const toWorkspace = home !== undefined && (!home.conversationId || home.kind === "workspace");
  const homeName = useHomeName(home);
  // A channel reads its group avatar and name, no `#` (task #55); the share dialog's sentence
  // keeps `#name`.
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
