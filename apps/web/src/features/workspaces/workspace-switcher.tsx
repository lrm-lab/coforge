import { useState } from "react";
import { Building07 as Building, Check, ChevronDown, Plus } from "@untitledui/icons";
import {
  Button as AriaButton,
  Header as AriaHeader,
  MenuItem as AriaMenuItem,
} from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import {
  CreateWorkspaceForm,
  type CreateWorkspaceInput,
} from "#src/features/workspaces/create-workspace-form";
import { cx } from "#src/utils/cx";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { WorkspaceIcon } from "#src/features/workspaces/workspace-icon";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";

export type WorkspaceOption = { id: string; slug: string; name: string; iconUrl: string | null };

export function WorkspaceSwitcher({
  workspaces,
  current,
  onSelect,
  onCreate,
}: {
  workspaces: WorkspaceOption[];
  current: WorkspaceOption | null;
  onSelect?: (slug: string) => Promise<void> | void;
  onCreate?: (input: CreateWorkspaceInput) => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const toast = useAppToast();
  const label = current?.name ?? m.workspace_unavailable_title();

  async function select(slug: string) {
    try {
      await onSelect?.(slug);
    } catch {
      toast.error(m.workspace_select_error());
    }
  }

  return (
    <>
      <Dropdown.Root>
        <AriaButton
          aria-label={m.workspace_switcher()}
          className="flex h-8 max-w-full min-w-0 items-center gap-1 rounded-lg bg-transparent px-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-brand"
        >
          <span data-workspace-name className="min-w-0 truncate text-sm font-semibold text-primary">
            {label}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
        </AriaButton>
        <Dropdown.Popover
          placement="bottom start"
          offset={6}
          className="w-(--trigger-width) min-w-56 rounded-xl p-1.5 shadow-lg"
        >
          <Dropdown.Menu aria-label={m.workspace_switcher()}>
            <Dropdown.Section>
              <AriaHeader className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-tertiary">
                {m.workspace_menu_label()}
              </AriaHeader>
              {workspaces.map((workspace) => (
                <AriaMenuItem
                  key={workspace.id}
                  id={workspace.id}
                  textValue={workspace.name}
                  onAction={() => void select(workspace.slug)}
                  className="group block cursor-pointer px-1.5 py-px outline-hidden"
                >
                  {(state) => (
                    <div
                      className={cx(
                        "relative flex items-center gap-2 rounded-md px-2.5 py-2 outline-focus-ring transition duration-100 ease-linear",
                        "group-hover:bg-primary_hover",
                        state.isFocused && "bg-primary_hover",
                        state.isFocusVisible && "outline-2 -outline-offset-2",
                      )}
                    >
                      <WorkspaceMark workspace={workspace} />
                      <span className="min-w-0 flex-1 truncate font-medium text-secondary">
                        {workspace.name}
                      </span>
                      {workspace.id === current?.id && (
                        <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                      )}
                    </div>
                  )}
                </AriaMenuItem>
              ))}
            </Dropdown.Section>
            {onCreate && (
              <>
                {workspaces.length > 0 && <Dropdown.Separator />}
                <Dropdown.Item
                  id="create-workspace"
                  icon={Plus}
                  label={m.workspace_create()}
                  onAction={() => setCreateOpen(true)}
                />
              </>
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      {onCreate && (
        <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={onCreate} />
      )}
    </>
  );
}

/** The Workspace's uploaded icon, or the building mark when it has none. */
function WorkspaceMark({ workspace }: { workspace: WorkspaceOption | null }) {
  if (workspace?.iconUrl)
    return (
      <span data-workspace-mark className="flex size-6 shrink-0">
        <WorkspaceIcon name={workspace.name} url={workspace.iconUrl} className="rounded-md" />
      </span>
    );
  return (
    <span
      data-workspace-mark
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center text-brand-secondary"
    >
      <Building className="size-5" />
    </span>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateWorkspaceInput) => Promise<void>;
}) {
  const close = () => onOpenChange(false);
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange}>
      <Modal className="w-[min(480px,calc(100vw-2rem))]">
        <Dialog>
          <DialogHeader
            title={m.workspace_create_title()}
            description={m.workspace_create_description()}
            onClose={close}
          />
          {/* The form lives inside the modal, so closing it starts the next one empty. */}
          <CreateWorkspaceForm
            onCreate={async (input) => {
              await onCreate(input);
              close();
            }}
            fieldsClassName="grid gap-4 px-6 py-6"
            actions={(submit) => (
              <DialogActions className="px-6 pt-4 pb-6">
                <DialogCancel type="button" onPress={close}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction {...submit} />
              </DialogActions>
            )}
          />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
