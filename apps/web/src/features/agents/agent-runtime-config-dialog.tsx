import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Trash01 } from "@untitledui/icons";
import { Disclosure, DisclosurePanel } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { PHONE_PAGE_HEADER, PhoneFormBar } from "#src/components/ui/phone-form-bar";
import {
  UnsavedChangesDialog,
  useReportDirty,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { ComputerStatusIcon } from "#src/features/computers/computer-status-icon";
import { m } from "#src/paraglide/messages";
import { agentEnvironmentNameError, agentEnvironmentRowsChanged } from "./agent-form";
import {
  AgentRuntimeFields,
  type RuntimeOptions,
  type RuntimeSelection,
} from "./agent-runtime-fields";

const MAX_ENV_ROWS = 64;

export type AgentEnvironmentState = { loaded: boolean; values: Record<string, string> };

export type AgentRuntimeComputerOption = {
  id: string;
  kind: string;
  name: string;
  displayName: string;
  online?: boolean;
};

type EnvironmentRow = { key: string; value: string };

export function AgentRuntimeConfigForm({
  computerId,
  computers,
  computerLocked = false,
  credentialConfigured = false,
  initial,
  onLoad,
  environment,
  saving,
  error,
  onClose,
  onDirtyChange,
  onSave,
}: {
  computerId: string;
  computers?: ReadonlyArray<AgentRuntimeComputerOption>;
  computerLocked?: boolean;
  credentialConfigured?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  environment?: AgentEnvironmentState;
  saving: boolean;
  error: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (form: FormData, changed: { runtime: boolean; environment: boolean }) => void;
}) {
  const controlSize = useDialogControlSize();
  const [selectedComputerId, setSelectedComputerId] = useState(
    computerId || computers?.[0]?.id || "",
  );
  useEffect(() => {
    if (computerId) setSelectedComputerId(computerId);
  }, [computerId]);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [envRows, setEnvRows] = useState<EnvironmentRow[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (!environment?.loaded || seeded.current) return;
    seeded.current = true;
    setEnvRows(Object.entries(environment.values).map(([key, value]) => ({ key, value })));
  }, [environment]);

  const envDirty = agentEnvironmentRowsChanged(envRows, environment?.values ?? {});
  const envKeyErrors = envRows.map((row) => agentEnvironmentNameError(row.key));
  const computerDirty = Boolean(computers) && selectedComputerId !== (computerId || "");
  const dirty = runtimeDirty || envDirty || computerDirty;
  useReportDirty(dirty, onDirtyChange);
  const envPending = environment !== undefined && !environment.loaded;
  const showComputerPicker = Boolean(computers && computers.length > 0);

  return (
    <form
      ref={formRef}
      className="max-sm:flex max-sm:min-h-full max-sm:flex-col"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSave(new FormData(event.currentTarget), {
          runtime: runtimeDirty || computerDirty,
          environment: envDirty,
        });
      }}
    >
      <PhoneFormBar
        heading={m.agent_profile_edit_runtime_config()}
        submitLabel={m.controls_save()}
        pending={saving}
        submitDisabled={!dirty || envPending || envKeyErrors.some(Boolean) || !selectedComputerId}
        onCancel={onClose}
        onSubmit={() => formRef.current?.requestSubmit()}
      />
      <DialogHeader
        className={PHONE_PAGE_HEADER}
        title={m.agent_profile_edit_runtime_config()}
        onClose={onClose}
      />
      <div className="grid gap-4 px-6 pt-6 pb-2 max-sm:px-4 max-sm:pt-2">
        {showComputerPicker ? (
          <Select
            name="computerId"
            isRequired
            isDisabled={computerLocked || saving}
            size={controlSize}
            label={m.agent_form_computer()}
            className="min-w-0"
            selectedKey={selectedComputerId || null}
            onSelectionChange={(key) => {
              if (key !== null) {
                setSelectedComputerId(String(key));
                setRuntimeDirty(true);
              }
            }}
          >
            {computers!.map((computer) => (
              <Select.Item
                key={computer.id}
                id={computer.id}
                label={computer.displayName}
                aria-label={`${computer.displayName}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
                icon={<ComputerStatusIcon computer={computer} online={Boolean(computer.online)} />}
              />
            ))}
          </Select>
        ) : computerId ? (
          <input type="hidden" name="computerId" value={computerId} />
        ) : null}
        {selectedComputerId ? (
          <AgentRuntimeFields
            key={selectedComputerId}
            open
            computerId={selectedComputerId}
            credentialConfigured={credentialConfigured}
            initial={initial}
            onLoad={onLoad}
            onDirtyChange={setRuntimeDirty}
          />
        ) : (
          <p className="text-sm text-tertiary">{m.agent_form_computer_required()}</p>
        )}
        {environment !== undefined && (
          <Disclosure>
            <Button
              slot="trigger"
              type="button"
              color="tertiary"
              size="sm"
              className="w-max gap-1 px-0 text-xs font-medium text-tertiary"
              iconLeading={ChevronDown}
            >
              {m.agent_env_more()}
            </Button>
            <DisclosurePanel>
              <div className="grid gap-3 pt-3">
                {envPending ? (
                  <p className="text-sm text-tertiary">{m.agent_env_loading()}</p>
                ) : (
                  <>
                    <div className="grid gap-1">
                      <p className="text-xs font-medium text-tertiary">{m.agent_env_title()}</p>
                      <p className="text-sm text-tertiary">{m.agent_env_description()}</p>
                    </div>
                    {envRows.map((row, index) => (
                      <div key={index} className="flex min-w-0 items-start gap-2">
                        <Input
                          name="envKey"
                          size={controlSize}
                          className="min-w-0 flex-1"
                          placeholder={m.agent_env_key_placeholder()}
                          isInvalid={Boolean(envKeyErrors[index])}
                          hint={envKeyErrors[index]}
                          value={row.key}
                          onChange={(value) =>
                            setEnvRows(
                              envRows.map((r, i) => (i === index ? { ...r, key: value } : r)),
                            )
                          }
                        />
                        <span aria-hidden="true" className="flex h-9 items-center text-tertiary">
                          =
                        </span>
                        <Input
                          name="envValue"
                          size={controlSize}
                          className="min-w-0 flex-1"
                          placeholder={m.agent_env_value_placeholder()}
                          value={row.value}
                          onChange={(value) =>
                            setEnvRows(envRows.map((r, i) => (i === index ? { ...r, value } : r)))
                          }
                        />
                        <div className="flex h-9 items-center">
                          <ButtonUtility
                            type="button"
                            size="xs"
                            color="tertiary"
                            icon={Trash01}
                            aria-label={m.agent_env_remove_label({ index: index + 1 })}
                            onClick={() => setEnvRows(envRows.filter((_, i) => i !== index))}
                          />
                        </div>
                      </div>
                    ))}
                    <Button
                      type="button"
                      color="secondary"
                      size="sm"
                      className="justify-self-start"
                      isDisabled={envRows.length >= MAX_ENV_ROWS}
                      onPress={() => setEnvRows([...envRows, { key: "", value: "" }])}
                    >
                      {m.agent_env_add()}
                    </Button>
                  </>
                )}
              </div>
            </DisclosurePanel>
          </Disclosure>
        )}
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
      </div>
      <DialogActions className="px-6 pt-4 pb-6 max-sm:hidden">
        <DialogCancel type="button" isDisabled={saving} onPress={onClose}>
          {m.controls_cancel()}
        </DialogCancel>
        <DialogAction
          type="submit"
          isDisabled={
            saving || !dirty || envPending || envKeyErrors.some(Boolean) || !selectedComputerId
          }
        >
          {saving ? m.agent_profile_saving() : m.agent_profile_save_runtime_config()}
        </DialogAction>
      </DialogActions>
    </form>
  );
}

export function AgentRuntimeConfigDialog({
  open,
  onClose,
  computerId,
  computers,
  computerLocked,
  credentialConfigured,
  initial,
  onLoad,
  environment,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  computerId: string;
  computers?: ReadonlyArray<AgentRuntimeComputerOption>;
  computerLocked?: boolean;
  credentialConfigured?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  environment?: AgentEnvironmentState;
  saving: boolean;
  error: string;
  onSave: (form: FormData, changed: { runtime: boolean; environment: boolean }) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const guard = useUnsavedChangesGuard({ overlayOpen: open, dirty, close: onClose });
  return (
    <>
      <ModalOverlay
        page
        isOpen={open}
        onOpenChange={(next: boolean) => {
          if (saving) return;
          if (!next) guard.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog>
            {({ close }) => (
              <AgentRuntimeConfigForm
                computerId={computerId}
                computers={computers}
                computerLocked={computerLocked}
                credentialConfigured={credentialConfigured}
                initial={initial}
                onLoad={onLoad}
                environment={environment}
                saving={saving}
                error={error}
                onClose={close}
                onDirtyChange={setDirty}
                onSave={onSave}
              />
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
