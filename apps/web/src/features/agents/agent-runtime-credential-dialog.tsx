import type { FormEvent } from "react";

import { Button } from "#src/components/base/buttons/button";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { m } from "#src/paraglide/messages";

/** One read-only runtime fact inside the dialog (Runtime / Model / Reasoning). Mirrors the
 * `RuntimeField` helper in `agent-detail.tsx`; kept local so this file has no dependency back on
 * the page that used to own it. */
function RuntimeField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-tertiary">{label}</p>
      <p className="mt-1 min-w-0 text-sm font-medium whitespace-pre-wrap break-words text-primary">
        {value || "—"}
      </p>
    </div>
  );
}

/**
 * The "Edit runtime" credential dialog: extracted out of `agent-detail.tsx`'s `Profile` so the
 * Agent profile panel's Runtime config pencil can open the same flow (see the panel brief:
 * "extract/reuse, do not rewrite the form"). Only the API key is editable here; Runtime/Model/
 * Reasoning are read-only facts carried over from the Agent's current runtime config — changing
 * those still requires the full Edit dialog on the Agent detail page (out of scope for the panel).
 */
export function AgentRuntimeCredentialDialog({
  open,
  onOpenChange,
  saving,
  runtimeLabel,
  providerId,
  credentialHint,
  error,
  onSave,
  onDelete,
  modelFields,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saving: boolean;
  runtimeLabel: string;
  providerId: string;
  /** The currently-configured key's masked hint, or `undefined` when none is set yet. */
  credentialHint?: string;
  error: string;
  onSave: (apiKey: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  modelFields: { label: string; value: string }[];
}) {
  const controlSize = useDialogControlSize();
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next: boolean) => {
        if (saving) return;
        onOpenChange(next);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog>
          {({ close }) => (
            <form
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const apiKey = String(new FormData(event.currentTarget).get("apiKey") ?? "");
                await onSave(apiKey);
              }}
            >
              <DialogHeader
                title={m.agent_runtime_edit_title()}
                description={m.agent_runtime_edit_description()}
                onClose={saving ? undefined : close}
              />
              <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
                <RuntimeField label={m.agent_runtime_field()} value={runtimeLabel} />
                {error && (
                  <p role="alert" className="text-sm text-error-primary sm:col-span-2">
                    {error}
                  </p>
                )}
                {providerId && (
                  <>
                    <RuntimeField label={m.agent_runtime_provider_field()} value={providerId} />
                    <Input
                      label={m.agent_runtime_api_key({ provider: providerId })}
                      name="apiKey"
                      type="password"
                      isRequired
                      minLength={8}
                      autoComplete="new-password"
                      placeholder={m.agent_runtime_api_key_placeholder({ provider: providerId })}
                      hint={
                        credentialHint
                          ? m.agent_runtime_api_key_configured({ hint: credentialHint })
                          : undefined
                      }
                      className="min-w-0 sm:col-span-2"
                    />
                  </>
                )}
                {modelFields.map((field) => (
                  <RuntimeField key={field.label} {...field} />
                ))}
              </div>
              <div className="flex justify-between gap-3 border-t border-secondary px-6 py-4">
                <div>
                  {credentialHint && onDelete && (
                    <Popconfirm
                      title={m.agent_runtime_delete_key()}
                      description={m.agent_runtime_delete_key_confirm({ provider: providerId })}
                      confirmLabel={m.agent_runtime_delete_key()}
                      pendingLabel={m.agent_runtime_deleting()}
                      errorMessage={m.agent_runtime_delete_error()}
                      placement="top start"
                      onConfirm={onDelete}
                    >
                      <Button
                        type="button"
                        size={controlSize}
                        color="secondary-destructive"
                        isDisabled={saving}
                      >
                        {m.agent_runtime_delete_key()}
                      </Button>
                    </Popconfirm>
                  )}
                </div>
                <DialogActions>
                  <DialogCancel
                    type="button"
                    isDisabled={saving}
                    onPress={() => onOpenChange(false)}
                  >
                    {m.controls_cancel()}
                  </DialogCancel>
                  <DialogAction type="submit" isDisabled={saving}>
                    {saving ? m.agent_runtime_saving() : m.agent_runtime_save()}
                  </DialogAction>
                </DialogActions>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
