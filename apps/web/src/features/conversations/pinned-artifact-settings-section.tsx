import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { DotsHorizontal, Pin02, SwitchHorizontal01, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { useArtifactLink } from "#src/features/artifacts/artifact-beside-chat";
import { ArtifactIcon, useArtifactTime } from "#src/features/artifacts/artifact-parts";
import { m } from "#src/paraglide/messages";
import { PinnedArtifactPickerDialog } from "./pinned-artifact-picker-dialog";
import { useConversationPinnedArtifact } from "./pinned-artifact-queries";
import { SectionEyebrow, SettingsCard } from "./settings-panel-parts";

export function PinnedArtifactSettingsSection({
  conversationId,
  channelName,
  isDm,
}: {
  conversationId: string;
  channelName?: string;
  isDm?: boolean;
}) {
  const { pinned, canEdit, isLoading, setPinned } = useConversationPinnedArtifact(conversationId);
  const artifactLink = useArtifactLink();
  const formatTime = useArtifactTime();
  const toast = useAppToast();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (isLoading || (!pinned && !canEdit)) return null;

  const title = pinned ? pinned.title || m.doc_untitled() : "";

  async function handleConfirm(nextArtifactId: string) {
    const hadPrevious = Boolean(pinned);
    const result = await setPinned(nextArtifactId);
    const nextTitle = result.pinned?.title || m.doc_untitled();
    toast.success(
      hadPrevious
        ? m.pinned_artifact_replaced_toast({ title: nextTitle })
        : m.pinned_artifact_pinned_toast({ title: nextTitle }),
    );
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

  return (
    <section>
      <SectionEyebrow icon={Pin02} title={m.pinned_artifact_label()} />
      <SettingsCard>
        {pinned ? (
          <div className="relative flex items-center gap-3 p-3.5 transition-colors hover:bg-primary_hover">
            <ArtifactIcon entryPath={pinned.entryPath} size="sm" />
            <div className="min-w-0 flex-1">
              <Link
                {...artifactLink(pinned.artifactId)}
                className="block truncate text-sm font-medium text-primary no-underline outline-focus-ring after:absolute after:inset-0 focus-visible:outline-2"
              >
                {title}
              </Link>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-tertiary">
                <span className="font-mono tabular-nums">v{pinned.version}</span>
                {pinned.updatedBy && <span className="truncate">{pinned.updatedBy.name}</span>}
                <time dateTime={pinned.updatedAt} className="shrink-0 tabular-nums">
                  {formatTime(pinned.updatedAt)}
                </time>
              </div>
            </div>
            {canEdit && (
              <div className="relative z-10 -mr-1.5 shrink-0">
                <Dropdown.Root>
                  <ButtonUtility
                    icon={DotsHorizontal}
                    size="sm"
                    color="tertiary"
                    aria-label={m.pinned_artifact_actions()}
                  />
                  <Dropdown.Popover placement="bottom end" className="w-max min-w-40">
                    <Dropdown.Menu aria-label={m.pinned_artifact_actions()}>
                      <Dropdown.Item icon={SwitchHorizontal01} onAction={() => setPickerOpen(true)}>
                        {m.pinned_artifact_replace()}
                      </Dropdown.Item>
                      <Dropdown.Item icon={XClose} onAction={() => void handleUnpin()}>
                        {m.pinned_artifact_unpin()}
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.Root>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 p-3.5">
            <p className="text-sm text-tertiary">{m.pinned_artifact_empty_title()}</p>
            <Button size="sm" color="secondary" onPress={() => setPickerOpen(true)}>
              {m.pinned_artifact_pin()}
            </Button>
          </div>
        )}
      </SettingsCard>

      {pickerOpen && (
        <PinnedArtifactPickerDialog
          conversationId={conversationId}
          channelName={channelName}
          isDm={isDm}
          currentArtifactId={pinned?.artifactId ?? null}
          onClose={() => setPickerOpen(false)}
          onConfirm={handleConfirm}
        />
      )}
    </section>
  );
}
