import { Fragment, useState } from "react";
import { Check, HelpCircle, Minus, XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { WORKSPACE_ROLE_CAPABILITIES } from "./workspace-role-capabilities";
import { WORKSPACE_MEMBER_ROLES } from "./workspace-roles";
import { workspaceRoleLabel } from "./workspace-role-label";

const ROLE_SUMMARY = {
  owner: () => m.workspace_role_owner_summary(),
  admin: () => m.workspace_role_admin_summary(),
  member: () => m.workspace_role_member_summary(),
} satisfies Record<(typeof WORKSPACE_MEMBER_ROLES)[number], () => string>;

/**
 * A help button beside a person's role that explains what each Workspace role may do: one line
 * per role, then capabilities by role, the way Slack's "Permissions by role" lays them out. A
 * dialog, not a tooltip, so it opens by click, keyboard and touch alike.
 */
export function WorkspaceRoleHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ButtonUtility
        icon={HelpCircle}
        size="xs"
        color="tertiary"
        tooltip={m.workspace_roles_help()}
        onClick={() => setOpen(true)}
      />
      <ModalOverlay isOpen={open} onOpenChange={setOpen} isDismissable>
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog className="max-h-[calc(100dvh-4rem)] overflow-y-auto p-6">
            {({ close }) => (
              <>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  className="absolute top-4 right-4"
                  onClick={close}
                />
                <Heading slot="title" className="pr-8 text-md font-semibold text-primary">
                  {m.workspace_roles_help_title()}
                </Heading>
                <dl className="mt-3 space-y-1">
                  {WORKSPACE_MEMBER_ROLES.map((role) => (
                    <div key={role} className="flex flex-wrap gap-x-2 text-sm">
                      <dt className="font-semibold text-primary">{workspaceRoleLabel(role)}</dt>
                      <dd className="text-tertiary">{ROLE_SUMMARY[role]()}</dd>
                    </div>
                  ))}
                </dl>
                <RoleMatrix />
                <p className="mt-4 text-sm text-tertiary">{m.workspace_roles_owner_note()}</p>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

/** Capabilities down the side, roles across the top, a check where the role has it. */
function RoleMatrix() {
  return (
    <table className="mt-5 w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-secondary">
          <th scope="col" className="py-2 pr-3 text-left font-medium text-tertiary">
            <span className="sr-only">{m.workspace_roles_capability()}</span>
          </th>
          {WORKSPACE_MEMBER_ROLES.map((role) => (
            <th
              key={role}
              scope="col"
              className="w-16 px-1 py-2 text-center text-xs font-semibold text-secondary"
            >
              {workspaceRoleLabel(role)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {WORKSPACE_ROLE_CAPABILITIES.map((group) => (
          <Fragment key={group.id}>
            <tr>
              <th
                scope="colgroup"
                colSpan={WORKSPACE_MEMBER_ROLES.length + 1}
                className="pt-4 pb-1 text-left text-xs font-semibold tracking-wide text-quaternary uppercase"
              >
                {group.label()}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.capability} className="border-b border-secondary last:border-b-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal text-secondary">
                  {row.label()}
                </th>
                {WORKSPACE_MEMBER_ROLES.map((role) => (
                  <td key={role} className="px-1 py-2 text-center">
                    {row.allows(role) ? (
                      <Check
                        role="img"
                        aria-label={m.workspace_roles_allowed()}
                        className="mx-auto size-4 text-fg-secondary"
                      />
                    ) : (
                      <Minus
                        role="img"
                        aria-label={m.workspace_roles_not_allowed()}
                        className="mx-auto size-4 text-fg-quaternary"
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
