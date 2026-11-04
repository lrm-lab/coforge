import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ClockRewind,
  DotsHorizontal,
  LinkExternal01,
  Link01,
  Trash01,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Skeleton } from "#src/components/ui/skeleton";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { StatusLine } from "./artifact-pane-header";
import { ArtifactIcon } from "./artifact-parts";
import type { ArtifactEditorStatus } from "./use-artifact-editor";

/** Where an artifact lives, as its page's way back names it. */
export type ArtifactHome = { kind: "channel" | "dm" | "workspace"; conversationId: string | null };

/**
 * An artifact's page's header (task #514): the way back to its conversation, its kind, title and
 * state, then its versions and more (copy link, open a web page in a tab of its own, delete).
 */
export function ArtifactPageHeader({
  kind,
  title,
  status,
  version,
  home,
  history,
  canDelete,
  onToggleHistory,
  onCopyLink,
  onOpenInTab,
  onDelete,
}: {
  /** Undefined until the artifact is read: the header holds its place. */
  kind: string | undefined;
  title: string;
  status: ArtifactEditorStatus | "old";
  version: number;
  home: ArtifactHome | undefined;
  history: boolean;
  canDelete: boolean;
  onToggleHistory?: () => void;
  onCopyLink?: () => void;
  onOpenInTab?: () => void;
  onDelete?: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-secondary px-3 sm:px-4">
      <BackToHome home={home} />
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border-secondary max-sm:hidden" />
      {kind === undefined ? (
        <Skeleton className="h-4 w-40" />
      ) : (
        <>
          <ArtifactIcon kind={kind} size="sm" />
          <h1 className="min-w-0 truncate text-sm font-semibold text-primary">{title}</h1>
          <span className="max-sm:hidden">
            <StatusLine status={status} version={version} />
          </span>
        </>
      )}
      <span className="flex-1" />
      {onToggleHistory && (
        <ButtonUtility
          icon={ClockRewind}
          size="sm"
          color="tertiary"
          tooltip={m.doc_history()}
          aria-pressed={history}
          className={cn(history && "bg-active")}
          onClick={onToggleHistory}
        />
      )}
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
    </header>
  );
}

/** Back to the conversation the artifact lives in: a channel by its name, a DM as "Back". */
function BackToHome({ home }: { home: ArtifactHome | undefined }) {
  const workspaceSlug = useWorkspaceSlug();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channelId = home?.kind === "channel" ? home.conversationId : null;
  const channels = useQuery({ ...channelNamesQuery(workspaceId), enabled: channelId !== null });
  const name = channelId ? channels.data?.find((c) => c.id === channelId)?.name : undefined;
  const label = name ? `#${name}` : m.doc_back();
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
