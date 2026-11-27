import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radio, RadioGroup } from "react-aria-components";
import { SearchLg } from "@untitledui/icons";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Badge } from "#src/components/base/badges/badges";
import { Input } from "#src/components/base/input/input";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { ArtifactIcon, useArtifactTime } from "#src/features/artifacts/artifact-parts";
import { artifactListQuery } from "#src/features/artifacts/artifact-queries";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function PinnedArtifactPickerDialog({
  conversationId,
  channelName,
  isDm,
  currentArtifactId,
  onClose,
  onConfirm,
}: {
  conversationId: string;
  channelName?: string;
  isDm?: boolean;
  currentArtifactId: string | null;
  onClose: () => void;
  onConfirm: (artifactId: string) => Promise<void>;
}) {
  const controlSize = useDialogControlSize();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const formatTime = useArtifactTime();

  const listQuery = useQuery(artifactListQuery(conversationId));

  const candidates = useMemo(() => {
    const items = listQuery.data ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) => {
      const title = (item.title || item.name || "").toLowerCase();
      return title.includes(term) || item.name.toLowerCase().includes(term);
    });
  }, [listQuery.data, search]);

  const effectiveSelectedId =
    selectedId && candidates.some((item) => item.id === selectedId)
      ? selectedId
      : (candidates.find((item) => item.id !== currentArtifactId)?.id ?? null);

  const canSubmit =
    !saving && effectiveSelectedId !== null && effectiveSelectedId !== currentArtifactId;

  async function submit() {
    if (!effectiveSelectedId || effectiveSelectedId === currentArtifactId) return;
    setSaving(true);
    setError(false);
    try {
      await onConfirm(effectiveSelectedId);
      onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay
      isOpen
      isDismissable={!saving}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left">
          <DialogHeader
            title={
              currentArtifactId
                ? m.pinned_artifact_picker_replace_title()
                : m.pinned_artifact_picker_set_title()
            }
            description={
              isDm || !channelName
                ? m.pinned_artifact_picker_dm_lead()
                : m.pinned_artifact_picker_channel_lead({ channel: channelName })
            }
            onClose={saving ? undefined : onClose}
          />

          <div className="mt-4 px-6">
            <Input
              size={controlSize}
              icon={SearchLg}
              placeholder={m.pinned_artifact_picker_search()}
              value={search}
              onChange={setSearch}
              isDisabled={saving}
              aria-label={m.pinned_artifact_picker_search()}
            />
          </div>

          <div className="mt-3 max-h-72 overflow-y-auto px-4">
            {listQuery.isLoading ? (
              <p role="status" className="px-2 py-6 text-center text-sm text-tertiary">
                {m.pinned_artifact_picker_loading()}
              </p>
            ) : listQuery.isError ? (
              <p role="alert" className="px-2 py-6 text-center text-sm text-error-primary">
                {m.pinned_artifact_picker_failed()}
              </p>
            ) : (listQuery.data?.length ?? 0) === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-tertiary">
                {m.pinned_artifact_picker_empty()}
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-tertiary">
                {m.pinned_artifact_picker_no_match()}
              </p>
            ) : (
              <RadioGroup
                aria-label={m.pinned_artifact_label()}
                value={effectiveSelectedId ?? ""}
                onChange={setSelectedId}
                isDisabled={saving}
                className="flex flex-col gap-1"
              >
                {candidates.map((item) => {
                  const isCurrent = item.id === currentArtifactId;
                  const label = item.title || m.doc_untitled();
                  return (
                    <Radio
                      key={item.id}
                      value={item.id}
                      isDisabled={isCurrent || saving}
                      className={({ isSelected, isFocusVisible }) =>
                        cn(
                          "flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors outline-focus-ring",
                          isFocusVisible && "outline-2 outline-offset-2",
                          isCurrent
                            ? "cursor-default border-transparent bg-secondary opacity-70"
                            : isSelected
                              ? "border-brand bg-primary_hover"
                              : "border-transparent hover:bg-primary_hover",
                        )
                      }
                    >
                      <ArtifactIcon entryPath={item.entryPath} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-primary">{label}</span>
                          {isCurrent && (
                            <Badge size="sm" color="gray" className="shrink-0">
                              {m.pinned_artifact_picker_current()}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-tertiary">
                          <span className="font-mono tabular-nums">v{item.currentVersion}</span>
                          <span className="tabular-nums">{formatTime(item.updatedAt)}</span>
                        </div>
                      </div>
                    </Radio>
                  );
                })}
              </RadioGroup>
            )}
          </div>

          {error && (
            <p role="alert" className="px-6 pt-3 text-sm text-error-primary">
              {m.pinned_artifact_action_error()}
            </p>
          )}

          <DialogActions className="mt-5 px-6 pb-6">
            <DialogCancel isDisabled={saving} onPress={onClose}>
              {m.channel_settings_cancel()}
            </DialogCancel>
            <DialogAction isDisabled={!canSubmit} isLoading={saving} onPress={() => void submit()}>
              {currentArtifactId
                ? m.pinned_artifact_picker_confirm_replace()
                : m.pinned_artifact_picker_confirm()}
            </DialogAction>
          </DialogActions>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
