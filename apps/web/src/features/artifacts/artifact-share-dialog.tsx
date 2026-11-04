import { Heading, Radio, RadioGroup } from "react-aria-components";
import { Building02, Check, Copy01, Lock01, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ArtifactAccess, ArtifactAccessState } from "./artifact-access";

/** Each level's icon, as the dialog and the page's Share button show it. */
export const ACCESS_ICON: Record<ArtifactAccess, typeof Lock01> = {
  conversation: Lock01,
  workspace: Building02,
};

const NOTE_ID = "artifact-share-note";

/**
 * Who can see an artifact (task #514; as Google Docs' "General access" and Notion's Share): one
 * of two levels, the narrower first, and its link; an artifact of the Workspace itself has only
 * the wider. Only those `canChange` names change the level (task #529); anyone else sees it
 * greyed, and who can.
 */
export function ArtifactShareDialog({
  open,
  onOpenChange,
  title,
  homeKind,
  homeName,
  state,
  onCopyLink,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  homeKind: "channel" | "dm" | "workspace";
  /** A channel's name as the first level says it ("#launch"). */
  homeName: string | undefined;
  state: ArtifactAccessState;
  onCopyLink: () => void;
}) {
  const levels: { id: ArtifactAccess; label: string; detail: string }[] = [
    ...(homeKind === "workspace"
      ? []
      : [
          {
            id: "conversation" as const,
            label: homeName
              ? m.doc_share_conversation({ home: homeName })
              : m.doc_share_conversation_dm(),
            detail: m.doc_share_conversation_detail(),
          },
        ]),
    {
      id: "workspace",
      label: m.doc_share_workspace(),
      detail: m.doc_share_workspace_detail(),
    },
  ];
  const { access, canChange, pending, error } = state;
  // Who may change it is unknown until read: greyed meanwhile, with no word on why.
  const note = canChange === false ? m.doc_share_read_only() : undefined;
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog aria-label={m.doc_share_title({ title })}>
          {({ close }) => (
            <div className="w-full p-5 text-left">
              <div className="flex items-start gap-3">
                <Heading
                  slot="title"
                  className="min-w-0 flex-1 truncate text-lg font-semibold text-primary"
                >
                  {m.doc_share_title({ title })}
                </Heading>
                <ButtonUtility
                  icon={XClose}
                  size="xs"
                  color="tertiary"
                  tooltip={m.doc_close()}
                  onClick={close}
                />
              </div>
              <RadioGroup
                aria-label={m.doc_share_who()}
                value={pending ?? access}
                onChange={(value) => void state.change(value as ArtifactAccess).catch(() => {})}
                isDisabled={canChange !== true || pending !== undefined}
                aria-describedby={note ? NOTE_ID : undefined}
                className="mt-4 flex flex-col gap-1.5"
              >
                {levels.map(({ id, label, detail }) => {
                  const Icon = ACCESS_ICON[id];
                  return (
                    <Radio
                      key={id}
                      value={id}
                      className={({ isSelected, isDisabled, isFocusVisible }) =>
                        cn(
                          "flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-inset transition",
                          isSelected
                            ? "bg-secondary ring-primary"
                            : "ring-secondary hover:bg-primary_hover",
                          isDisabled && "cursor-default hover:bg-transparent",
                          isDisabled && "opacity-60",
                          isFocusVisible && "outline-2 outline-focus-ring",
                        )
                      }
                    >
                      {({ isSelected }) => (
                        <>
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary ring-1 ring-secondary">
                            <Icon aria-hidden="true" className="size-4 text-fg-secondary" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-primary">{label}</span>
                            <span className="mt-0.5 block text-sm text-tertiary">{detail}</span>
                          </span>
                          {isSelected && (
                            <Check
                              aria-hidden="true"
                              className="mt-1 size-4 shrink-0 text-fg-primary"
                            />
                          )}
                        </>
                      )}
                    </Radio>
                  );
                })}
              </RadioGroup>
              {note && (
                <p id={NOTE_ID} className="mt-3 text-sm text-tertiary">
                  {note}
                </p>
              )}
              {error && (
                <p role="alert" className="mt-3 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-5 flex items-center gap-2">
                <Button size="md" color="secondary" iconLeading={Copy01} onClick={onCopyLink}>
                  {m.doc_copy_link()}
                </Button>
                <Button size="md" color="primary" className="ml-auto" onClick={close}>
                  {m.doc_share_done()}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
