import { useState } from "react";
import { Heading, Radio, RadioGroup } from "react-aria-components";
import { Building02, Check, Copy01, Globe02, Lock01, Send01, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Toggle } from "#src/components/base/toggle/toggle";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ArtifactAccess, ArtifactAccessState } from "./artifact-access";
import type { ArtifactLinkSharing } from "./artifact-link-sharing";

/** Each level's icon, as the dialog and the page's Share button show it. */
export const ACCESS_ICON: Record<ArtifactAccess, typeof Lock01> = {
  conversation: Lock01,
  workspace: Building02,
};

/** What the page's Share button shows: a live public link outranks the level beneath it. */
export const shareIcon = (access: ArtifactAccess, link: ArtifactLinkSharing) =>
  link.url ? Globe02 : ACCESS_ICON[access];

const NOTE_ID = "artifact-share-note";
const WARNING_ID = "artifact-share-lock-out";
const LINK_LABEL_ID = "artifact-share-link";
const LINK_DETAIL_ID = "artifact-share-link-detail";

/**
 * Who can see an artifact (task #514; as Google Docs' "General access" and Notion's Share): one
 * of two levels, the narrower first, and its link; an artifact of the Workspace itself has only
 * the wider. Only those `canChange` names change the level (task #529); anyone else sees it
 * greyed, and who can. One who reads it only through the Workspace level confirms a change to
 * the narrower, which shuts them out. Beneath the levels, for the artifacts that can have one, a
 * switch for a public link anyone can open without signing in (task #646).
 */
export function ArtifactShareDialog({
  open,
  onOpenChange,
  title,
  homeKind,
  homeName,
  state,
  link,
  onCopyLink,
  onCopyPublicLink,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  homeKind: "channel" | "dm" | "workspace";
  /** A channel's name as the first level says it ("#launch"). */
  homeName: string | undefined;
  state: ArtifactAccessState;
  link: ArtifactLinkSharing;
  onCopyLink: () => void;
  onCopyPublicLink: (url: string) => void;
  /** Opens the Send dialog (posting its link into channels and DMs); this one closes. */
  onSend?: () => void;
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
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog aria-label={m.doc_share_title({ title })}>
          {({ close }) => (
            <ShareBody
              title={title}
              levels={levels}
              state={state}
              link={link}
              onCopyLink={onCopyLink}
              onCopyPublicLink={onCopyPublicLink}
              onSend={onSend}
              close={close}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The dialog's content, mounted while it is open: a confirmation pending starts over each time. */
function ShareBody({
  title,
  levels,
  state,
  link,
  onCopyLink,
  onCopyPublicLink,
  onSend,
  close,
}: {
  title: string;
  levels: { id: ArtifactAccess; label: string; detail: string }[];
  state: ArtifactAccessState;
  link: ArtifactLinkSharing;
  onCopyLink: () => void;
  onCopyPublicLink: (url: string) => void;
  onSend?: () => void;
  close: () => void;
}) {
  const { access, canChange, locksOut, pending, error } = state;
  const controlSize = useDialogControlSize();
  /** The narrower level, chosen by one it would shut out, until they confirm or keep it. */
  const [confirming, setConfirming] = useState(false);
  // Who may change it is unknown until read: greyed meanwhile, with no word on why.
  const note = canChange === false ? m.doc_share_read_only() : undefined;
  const change = (next: ArtifactAccess) => void state.change(next).catch(() => {});
  return (
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
        onChange={(value) =>
          value === "conversation" && locksOut
            ? setConfirming(true)
            : change(value as ArtifactAccess)
        }
        isDisabled={canChange !== true || pending !== undefined || confirming}
        aria-describedby={note ? NOTE_ID : confirming ? WARNING_ID : undefined}
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
                    <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-fg-primary" />
                  )}
                </>
              )}
            </Radio>
          );
        })}
      </RadioGroup>
      {link.available && (
        <PublicLink
          link={link}
          canChange={canChange === true}
          controlSize={controlSize}
          onCopy={onCopyPublicLink}
        />
      )}
      {note && (
        <p id={NOTE_ID} className="mt-3 text-sm text-tertiary">
          {note}
        </p>
      )}
      {confirming && (
        <div className="mt-3 rounded-xl border border-utility-yellow-300 bg-warning-primary p-3">
          <p id={WARNING_ID} className="text-sm text-warning-primary">
            {m.doc_share_lock_out()}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" color="secondary" onClick={() => setConfirming(false)}>
              {m.doc_share_keep()}
            </Button>
            <Button
              size="sm"
              color="primary-destructive"
              onClick={() => {
                setConfirming(false);
                change("conversation");
              }}
            >
              {m.doc_share_lock_out_confirm()}
            </Button>
          </div>
        </div>
      )}
      {(error ?? link.error) && (
        <p role="alert" className="mt-3 text-sm text-error-primary">
          {error ?? link.error}
        </p>
      )}
      <div className="mt-5 flex items-center gap-2">
        <Button size={controlSize} color="secondary" iconLeading={Copy01} onClick={onCopyLink}>
          {m.doc_copy_link()}
        </Button>
        {onSend && (
          <Button size={controlSize} color="secondary" iconLeading={Send01} onClick={onSend}>
            {m.doc_send_action()}
          </Button>
        )}
        <Button size={controlSize} color="primary" className="ml-auto" onClick={close}>
          {m.doc_share_done()}
        </Button>
      </div>
    </div>
  );
}

/** The public link's switch, and the link while it is on. */
function PublicLink({
  link,
  canChange,
  controlSize,
  onCopy,
}: {
  link: ArtifactLinkSharing;
  canChange: boolean;
  controlSize: "sm" | "md";
  onCopy: (url: string) => void;
}) {
  const on = link.pending ?? link.url !== null;
  return (
    <div className="mt-1.5 rounded-xl p-3 ring-1 ring-secondary ring-inset">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary ring-1 ring-secondary">
          <Globe02 aria-hidden="true" className="size-4 text-fg-secondary" />
        </span>
        <span className="min-w-0 flex-1">
          <span id={LINK_LABEL_ID} className="block text-sm font-medium text-primary">
            {m.doc_share_link()}
          </span>
          <span id={LINK_DETAIL_ID} className="mt-0.5 block text-sm text-tertiary">
            {m.doc_share_link_detail()}
          </span>
        </span>
        <Toggle
          aria-labelledby={LINK_LABEL_ID}
          aria-describedby={LINK_DETAIL_ID}
          className="mt-1 shrink-0"
          isSelected={on}
          isDisabled={!canChange || link.pending !== undefined}
          onChange={link.change}
        />
      </div>
      {link.url && link.pending !== false && (
        <div className="mt-3 flex flex-col gap-2 pl-11">
          <p className="text-sm break-all text-secondary">{link.url}</p>
          <Button
            size={controlSize}
            color="secondary"
            iconLeading={Copy01}
            className="self-start"
            onClick={() => link.url && onCopy(link.url)}
          >
            {m.doc_copy_public_link()}
          </Button>
        </div>
      )}
    </div>
  );
}
