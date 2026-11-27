import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import {
  Copy01,
  DotsHorizontal,
  EyeOff,
  Pin02,
  SwitchHorizontal01,
  XClose,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { useArtifactLink } from "#src/features/artifacts/artifact-beside-chat";
import { useArtifactTime } from "#src/features/artifacts/artifact-parts";
import { artifactPageRoute } from "#src/features/artifacts/artifact-search";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { HEADER_ICON_CLASS } from "./conversation-header-tabs";
import { PinnedArtifactPickerDialog } from "./pinned-artifact-picker-dialog";
import { useConversationPinnedArtifact } from "./pinned-artifact-queries";

export function PinnedArtifactRestoreButton({ conversationId }: { conversationId: string }) {
  const { pinned, dismissed, restore } = useConversationPinnedArtifact(conversationId);
  const toast = useAppToast();
  if (!pinned || !dismissed) return null;
  const title = pinned.title || m.doc_untitled();
  return (
    <ButtonUtility
      icon={Pin02}
      size="sm"
      color="tertiary"
      className={HEADER_ICON_CLASS}
      tooltip={m.pinned_artifact_show_tooltip({ title })}
      onClick={() => {
        toast.dismiss(m.pinned_artifact_hidden_toast());
        restore();
      }}
    />
  );
}

export function ConversationPinnedArtifactStrip({
  conversationId,
  channelName,
  isDm,
}: {
  conversationId: string;
  channelName?: string;
  isDm?: boolean;
}) {
  const { pinned, canEdit, dismissed, dismiss, restore, setPinned } = useConversationPinnedArtifact(
    conversationId,
    { subscribe: true },
  );
  const artifactLink = useArtifactLink();
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const formatTime = useArtifactTime();
  const toast = useAppToast();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!pinned || dismissed) return null;

  const title = pinned.title || m.doc_untitled();
  const unread = !pinned.seen;
  const updaterName = pinned.updatedBy?.name;
  const secondaryText = unread
    ? updaterName && pinned.note
      ? m.pinned_artifact_updated_with_note({ name: updaterName, note: pinned.note })
      : updaterName
        ? m.pinned_artifact_updated_by({ name: updaterName })
        : pinned.note || pinned.preview
    : pinned.preview || (updaterName ? m.pinned_artifact_updated_by({ name: updaterName }) : "");

  function handleDismiss() {
    if (!pinned) return;
    dismiss(pinned.artifactId, pinned.version);
    toast.undoable(m.pinned_artifact_hidden_toast(), {
      onUndo: restore,
    });
  }

  async function handleCopyLink() {
    if (!pinned) return;
    const href = router.buildLocation(artifactPageRoute(workspaceSlug, pinned.artifactId)).href;
    const url = new URL(href, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      toast.success(m.pinned_artifact_link_copied());
    } catch {
      toast.error(m.pinned_artifact_action_error());
    }
  }

  async function handleUnpin() {
    if (!pinned) return;
    const previousId = pinned.artifactId;
    const previousTitle = title;
    try {
      await setPinned(null);
      toast.undoable(m.pinned_artifact_unpinned_toast({ title: previousTitle }), {
        onUndo: () => setPinned(previousId),
        failed: m.pinned_artifact_action_error(),
      });
    } catch {
      toast.error(m.pinned_artifact_action_error());
    }
  }

  async function handleReplace(nextArtifactId: string) {
    const result = await setPinned(nextArtifactId);
    const nextTitle = result.pinned?.title || m.doc_untitled();
    toast.success(m.pinned_artifact_replaced_toast({ title: nextTitle }));
  }

  return (
    <>
      <div
        data-pinned-artifact-strip
        data-state={unread ? "unread" : "read"}
        className="relative flex min-h-10 any-pointer-coarse:min-h-11 shrink-0 items-center gap-2 border-b border-secondary bg-primary px-4 transition-colors hover:bg-primary_hover md:px-6"
      >
        <Pin02 aria-hidden="true" className="size-4 shrink-0 text-fg-tertiary" />

        <Link
          {...artifactLink(pinned.artifactId)}
          aria-label={m.pinned_artifact_open_label({ title })}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 no-underline outline-focus-ring after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        >
          <span
            className={cn(
              "min-w-0 truncate text-sm text-primary",
              secondaryText ? "sm:max-w-[50%] sm:shrink-0" : "flex-1",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {title}
          </span>
          {secondaryText && (
            <span className="hidden min-w-0 flex-1 items-center gap-1.5 text-xs sm:flex">
              {unread && pinned.updatedBy && (
                <ActorAvatar
                  presence={false}
                  size="xs"
                  userId={pinned.updatedBy.kind === "user" ? pinned.updatedBy.id : undefined}
                  agentId={pinned.updatedBy.kind === "agent" ? pinned.updatedBy.id : undefined}
                  src={pinned.updatedBy.avatarUrl ?? undefined}
                  name={pinned.updatedBy.name}
                  className="size-4 shrink-0"
                />
              )}
              <span className={cn("min-w-0 truncate", unread ? "text-secondary" : "text-tertiary")}>
                {secondaryText}
              </span>
            </span>
          )}
        </Link>

        <div className="relative z-10 -mr-1.5 flex shrink-0 items-center gap-1.5">
          {unread && (
            <span className="inline-flex items-center">
              <UnreadDot />
              <span className="sr-only">{m.pinned_artifact_unread_label()}</span>
            </span>
          )}
          <span className="hidden font-mono text-xs text-tertiary tabular-nums sm:inline">
            v{pinned.version}
          </span>
          <time
            dateTime={pinned.updatedAt}
            className="hidden text-xs text-tertiary tabular-nums md:inline"
          >
            {formatTime(pinned.updatedAt)}
          </time>
          <Dropdown.Root>
            <ButtonUtility
              icon={DotsHorizontal}
              size="sm"
              color="tertiary"
              tooltip={m.pinned_artifact_actions()}
            />
            <Dropdown.Popover placement="bottom end" className="w-max min-w-44">
              <Dropdown.Menu aria-label={m.pinned_artifact_actions()}>
                <Dropdown.Item icon={Copy01} onAction={() => void handleCopyLink()}>
                  {m.pinned_artifact_copy_link()}
                </Dropdown.Item>
                <Dropdown.Item icon={EyeOff} onAction={handleDismiss}>
                  {m.pinned_artifact_hide_for_me()}
                </Dropdown.Item>
                {canEdit && <Dropdown.Separator />}
                {canEdit && (
                  <Dropdown.Item icon={SwitchHorizontal01} onAction={() => setPickerOpen(true)}>
                    {m.pinned_artifact_replace()}
                  </Dropdown.Item>
                )}
                {canEdit && (
                  <Dropdown.Item icon={XClose} onAction={() => void handleUnpin()}>
                    {m.pinned_artifact_unpin()}
                  </Dropdown.Item>
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
          <ButtonUtility
            icon={XClose}
            size="sm"
            color="tertiary"
            tooltip={m.pinned_artifact_hide_tooltip()}
            onClick={handleDismiss}
          />
        </div>
      </div>

      {pickerOpen && (
        <PinnedArtifactPickerDialog
          conversationId={conversationId}
          channelName={channelName}
          isDm={isDm}
          currentArtifactId={pinned.artifactId}
          onClose={() => setPickerOpen(false)}
          onConfirm={handleReplace}
        />
      )}
    </>
  );
}
