import { useEffect, useRef } from "react";

import { Button } from "#src/components/base/buttons/button";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";

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

function AgentRuntimeCredentialForm({
  saving,
  runtimeLabel,
  providerId,
  credentialHint,
  error,
  onErrorClear,
  onSave,
  onDelete,
  onCancel,
  onClose,
  modelFields,
}: {
  saving: boolean;
  runtimeLabel: string;
  providerId: string;
  credentialHint?: string;
  error: string;
  onErrorClear?: () => void;
  onSave: (apiKey: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel: () => void;
  onClose: () => void;
  modelFields: { label: string; value: string }[];
}) {
  const controlSize = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);
  const prevError = useRef("");

  const form = useAppForm({
    defaultValues: { apiKey: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current, "apiKey"),
    onSubmit: async ({ value }) => {
      await onSave(value.apiKey);
    },
  });

  useEffect(() => {
    if (error && providerId) {
      setFieldServerError(form, "apiKey", error, formRef.current);
    } else if (prevError.current && form.getFieldMeta("apiKey")?.errorMap.onSubmit) {
      form.setFieldMeta("apiKey", (prev) => ({
        ...prev,
        errorMap: { ...prev.errorMap, onSubmit: undefined },
      }));
    }
    prevError.current = error;
  }, [error, providerId, form]);

  return (
    <form.AppForm>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <DialogHeader
          title={m.agent_runtime_edit_title()}
          description={m.agent_runtime_edit_description()}
          onClose={saving ? undefined : onClose}
        />
        <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
          <RuntimeField label={m.agent_runtime_field()} value={runtimeLabel} />
          {!providerId && (
            <form.Alert error={error} className="text-sm text-error-primary sm:col-span-2" />
          )}
          {providerId && (
            <>
              <RuntimeField label={m.agent_runtime_provider_field()} value={providerId} />
              <form.AppField name="apiKey">
                {(field) => (
                  <field.Input
                    label={m.agent_runtime_api_key({ provider: providerId })}
                    type="password"
                    isRequired
                    minLength={8}
                    autoComplete="new-password"
                    placeholder={m.agent_runtime_api_key_placeholder({ provider: providerId })}
                    onChange={() => onErrorClear?.()}
                    hint={
                      credentialHint
                        ? m.agent_runtime_api_key_configured({ hint: credentialHint })
                        : undefined
                    }
                    className="min-w-0 sm:col-span-2"
                  />
                )}
              </form.AppField>
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
            <DialogCancel type="button" isDisabled={saving} onPress={onCancel}>
              {m.controls_cancel()}
            </DialogCancel>
            <DialogAction type="submit" isDisabled={saving}>
              {saving ? m.agent_runtime_saving() : m.agent_runtime_save()}
            </DialogAction>
          </DialogActions>
        </div>
      </form>
    </form.AppForm>
  );
}

export function AgentRuntimeCredentialDialog({
  open,
  onOpenChange,
  saving,
  runtimeLabel,
  providerId,
  credentialHint,
  error,
  onErrorClear,
  onSave,
  onDelete,
  modelFields,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saving: boolean;
  runtimeLabel: string;
  providerId: string;
  credentialHint?: string;
  error: string;
  onErrorClear?: () => void;
  onSave: (apiKey: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  modelFields: { label: string; value: string }[];
}) {
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
            <AgentRuntimeCredentialForm
              saving={saving}
              runtimeLabel={runtimeLabel}
              providerId={providerId}
              credentialHint={credentialHint}
              error={error}
              onErrorClear={onErrorClear}
              onSave={onSave}
              onDelete={onDelete}
              onCancel={() => onOpenChange(false)}
              onClose={close}
              modelFields={modelFields}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
