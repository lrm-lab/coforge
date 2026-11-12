import { Heading } from "react-aria-components";
import { Building02, Copy01, Globe02, Send01, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Toggle } from "#src/components/base/toggle/toggle";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import type { ArtifactLinkSharing } from "./artifact-link-sharing";

/** What the page's Share button shows: a live public link outranks the Workspace row (task #20). */
export const shareIcon = (link: ArtifactLinkSharing) => (link.url ? Globe02 : Building02);

const NOTE_ID = "artifact-share-note";
const LINK_LABEL_ID = "artifact-share-link";
const LINK_DETAIL_ID = "artifact-share-link-detail";

/**
 * Who can see an artifact (task #20): every member of the Workspace, always — the first row
 * says so and there is nothing to choose — and, for the artifacts that can have one, a switch
 * for a public link anyone can open without signing in (task #646). Only those `canChange`
 * names may flip that switch: the human author, the owner of the Agent that made it, or a
 * Workspace owner or admin; an Agent never may.
 */
export function ArtifactShareDialog({
  open,
  onOpenChange,
  title,
  canChange,
  link,
  onCopyLink,
  onCopyPublicLink,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Whether the viewer may manage the public link; undefined until read. */
  canChange: boolean | undefined;
  link: ArtifactLinkSharing;
  onCopyLink: () => void;
  onCopyPublicLink: (url: string) => void;
  /** Opens the Send dialog (posting its link into channels and DMs); this one closes. */
  onSend?: () => void;
}) {
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog aria-label={m.doc_share_title({ title })}>
          {({ close }) => (
            <ShareBody
              title={title}
              canChange={canChange}
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

function ShareBody({
  title,
  canChange,
  link,
  onCopyLink,
  onCopyPublicLink,
  onSend,
  close,
}: {
  title: string;
  canChange: boolean | undefined;
  link: ArtifactLinkSharing;
  onCopyLink: () => void;
  onCopyPublicLink: (url: string) => void;
  onSend?: () => void;
  close: () => void;
}) {
  const controlSize = useDialogControlSize();
  // Who may change the link is unknown until read: greyed meanwhile, with no word on why.
  const note = canChange === false ? m.doc_share_read_only() : undefined;
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
      <div className="mt-4 flex items-center gap-3">
        <Building02 aria-hidden="true" className="size-4 shrink-0 text-fg-secondary" />
        <span className="text-sm font-medium text-primary">{m.doc_share_workspace()}</span>
      </div>
      {link.available && (
        <PublicLink
          link={link}
          canChange={canChange === true}
          controlSize={controlSize}
          onCopy={onCopyPublicLink}
        />
      )}
      {link.available && note && (
        <p id={NOTE_ID} className="mt-3 text-sm text-tertiary">
          {note}
        </p>
      )}
      {link.error && (
        <p role="alert" className="mt-3 text-sm text-error-primary">
          {link.error}
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
