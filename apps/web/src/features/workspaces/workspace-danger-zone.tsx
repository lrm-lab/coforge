import { useCallback, useRef, useState, type FC, type ReactNode, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";
import { AlertTriangle, LogOut01, Trash01 } from "@untitledui/icons";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { SettingsCard, SettingsGroup } from "#src/components/settings-layout";
import { SaveErrorMessage, saveErrorFrom, type SaveError } from "#src/components/save-error";
import { isAppError, type AppError, type AppErrorCode } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { DepartureImpact, useDepartureImpact } from "./departure-impact-view";
import { leaveWorkspace, previewWorkspaceLeave } from "./members.functions";
import { canDeleteWorkspace } from "./workspace-roles";
import { deleteWorkspace } from "./workspaces.functions";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";

type DialogProps = {
  open: boolean;
  workspaceName: string;
  onClose: () => void;
};

export function WorkspaceDangerZone({
  workspaceName,
  workspaceSlug,
  actorRole,
}: {
  workspaceName: string;
  workspaceSlug: string;
  actorRole: string;
}) {
  const [open, setOpen] = useState(false);
  const owner = canDeleteWorkspace(actorRole);
  const dialog = { open, workspaceName, onClose: () => setOpen(false) };
  const action = owner
    ? {
        title: m.settings_delete_workspace(),
        description: m.settings_delete_workspace_description(),
        icon: Trash01,
      }
    : {
        title: m.settings_leave_workspace(),
        description: m.settings_leave_workspace_description(),
        icon: LogOut01,
      };

  return (
    <SettingsGroup icon={AlertTriangle} label={m.settings_danger_zone()}>
      <SettingsCard>
        <DangerAction {...action} onPress={() => setOpen(true)} />
      </SettingsCard>
      {owner ? (
        <DeleteWorkspaceDialog {...dialog} workspaceSlug={workspaceSlug} />
      ) : (
        <LeaveWorkspaceDialog {...dialog} />
      )}
    </SettingsGroup>
  );
}

function DangerAction({
  title,
  description,
  icon,
  onPress,
}: {
  title: string;
  description: string;
  icon: FC<{ className?: string }>;
  onPress: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        <p className="mt-1 text-sm text-tertiary">{description}</p>
      </div>
      <Button
        size="sm"
        color="secondary-destructive"
        iconLeading={icon}
        className="shrink-0 self-start sm:self-auto"
        onPress={onPress}
      >
        {title}
      </Button>
    </div>
  );
}

function useWorkspaceDeparture<TInput = void>({
  write,
  outAlready,
  messageFor,
}: {
  write: (input: TInput) => Promise<{ nextWorkspaceSlug: string | null }>;
  outAlready: readonly AppErrorCode[];
  messageFor: (refusal: AppError | undefined) => string;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);

  async function depart(input: TInput, onRefusal?: (refusal: AppError) => boolean) {
    setBusy(true);
    setError(null);
    let next: string | null;
    try {
      next = (await write(input)).nextWorkspaceSlug;
    } catch (cause) {
      const refusal = isAppError(cause) ? cause : undefined;
      if (refusal && onRefusal?.(refusal)) {
        setBusy(false);
        return;
      }
      if (!refusal || !outAlready.includes(refusal.code)) {
        setError(saveErrorFrom(messageFor(refusal), cause));
        setBusy(false);
        return;
      }
      next = null;
    }
    try {
      if (next)
        await navigate({
          to: "/w/$workspaceSlug",
          params: { workspaceSlug: next },
        });
      else await navigate({ to: "/" });
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, depart, clearError: () => setError(null) };
}

function LeaveWorkspaceDialog({ open, workspaceName, onClose }: DialogProps) {
  const leave = useServerFn(leaveWorkspace);
  const preview = useServerFn(previewWorkspaceLeave);
  const load = useCallback(() => preview(), [preview]);
  const impact = useDepartureImpact({ open, subject: "leave", load });
  const { busy, error, depart, clearError } = useWorkspaceDeparture<void>({
    write: () => leave(),
    outAlready: ["NOT_FOUND", "ACCESS_DENIED"],
    messageFor: (refusal) =>
      refusal?.code === "CONFLICT"
        ? m.settings_leave_workspace_owner()
        : m.settings_leave_workspace_error(),
  });

  const form = useAppForm({
    defaultValues: {},
    onSubmit: async () => {
      if (impact.state.kind === "loading" || busy) return;
      await depart();
    },
  });

  return (
    <form.AppForm>
      <DangerDialog
        open={open}
        busy={busy}
        title={m.settings_leave_workspace()}
        description={m.settings_leave_workspace_confirm({ name: workspaceName })}
        detail={
          <DepartureImpact
            state={impact.state}
            subject={{ kind: "leave" }}
            onRetry={impact.retry}
          />
        }
        isConfirmDisabled={impact.state.kind === "loading"}
        error={error}
        onClose={() => {
          clearError();
          onClose();
        }}
        confirmLabel={busy ? m.settings_leave_workspace_leaving() : m.settings_leave_workspace()}
        onConfirm={() => void form.handleSubmit()}
      />
    </form.AppForm>
  );
}

function deleteRefusalMessage(refusal: AppError | undefined, slug: string) {
  if (refusal?.errorId === "workspace-memory-removal-failed")
    return m.settings_delete_workspace_memory_error();
  if (refusal?.code === "INVALID_INPUT") return m.settings_delete_workspace_mismatch({ slug });
  if (refusal?.code === "ACCESS_DENIED") return m.settings_delete_workspace_denied();
  return m.settings_delete_workspace_error();
}

function DeleteWorkspaceDialog({
  open,
  workspaceName,
  workspaceSlug,
  onClose,
}: DialogProps & { workspaceSlug: string }) {
  const controlSize = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);
  const remove = useServerFn(deleteWorkspace);

  const { busy, error, depart, clearError } = useWorkspaceDeparture<string>({
    write: (confirmSlug) => remove({ data: { confirmSlug } }),
    outAlready: ["NOT_FOUND"],
    messageFor: (refusal) => deleteRefusalMessage(refusal, workspaceSlug),
  });

  const form = useAppForm({
    defaultValues: { confirmSlug: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (busy) return;
      await depart(value.confirmSlug, (refusal) => {
        if (refusal.code !== "INVALID_INPUT") return false;
        setFieldServerError(
          form,
          "confirmSlug",
          m.settings_delete_workspace_mismatch({ slug: workspaceSlug }),
          formRef.current,
        );
        return true;
      });
    },
  });

  return (
    <form.AppForm>
      <form.Subscribe selector={(state) => state.values.confirmSlug !== workspaceSlug}>
        {(slugMismatch) => (
          <DangerDialog
            open={open}
            busy={busy}
            formRef={formRef}
            title={m.settings_delete_workspace()}
            description={m.settings_delete_workspace_confirm({ name: workspaceName })}
            error={error}
            onClose={() => {
              form.reset();
              clearError();
              onClose();
            }}
            confirmLabel={
              busy ? m.settings_delete_workspace_deleting() : m.settings_delete_workspace()
            }
            isConfirmDisabled={slugMismatch}
            onConfirm={() => void form.handleSubmit()}
          >
            <div className="mx-6 mt-4">
              <form.AppField
                name="confirmSlug"
                validators={{
                  onSubmit: ({ value }) =>
                    value === workspaceSlug
                      ? undefined
                      : m.settings_delete_workspace_mismatch({ slug: workspaceSlug }),
                }}
              >
                {(field) => (
                  <field.Input
                    size={controlSize}
                    label={m.settings_delete_workspace_type_slug({ slug: workspaceSlug })}
                    placeholder={workspaceSlug}
                    autoFocus
                    autoComplete="off"
                    spellCheck="false"
                    inputClassName="font-mono"
                    isDisabled={busy}
                    onChange={() => clearError()}
                  />
                )}
              </form.AppField>
            </div>
          </DangerDialog>
        )}
      </form.Subscribe>
    </form.AppForm>
  );
}

function DangerDialog({
  open,
  busy,
  formRef,
  title,
  description,
  detail,
  error,
  onClose,
  confirmLabel,
  isConfirmDisabled = false,
  onConfirm,
  children,
}: {
  open: boolean;
  busy: boolean;
  formRef?: RefObject<HTMLFormElement | null>;
  title: string;
  description: string;
  detail?: ReactNode;
  error: SaveError | null;
  onClose: () => void;
  confirmLabel: string;
  isConfirmDisabled?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (next || busy) return;
        onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left">
          {({ close }) => (
            <form
              ref={formRef}
              noValidate
              className="contents"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) onConfirm();
              }}
            >
              <DialogHeader title={title} onClose={busy ? undefined : close} />
              <Text
                slot="description"
                elementType="div"
                className="mx-6 mt-4 block text-sm text-secondary"
              >
                {description}
                {detail}
              </Text>
              {children}
              {error && (
                <div className="px-6 pt-4">
                  <SaveErrorMessage error={error} />
                </div>
              )}
              <DialogActions className="mt-6 px-6 pb-6">
                <DialogCancel isDisabled={busy} onPress={close}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  type="submit"
                  color="primary-destructive"
                  isDisabled={busy || isConfirmDisabled}
                  isLoading={busy}
                  showTextWhileLoading
                >
                  {confirmLabel}
                </DialogAction>
              </DialogActions>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
