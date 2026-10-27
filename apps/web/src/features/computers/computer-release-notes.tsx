import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Heading } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { getComputerReleaseNotes } from "./computers.functions";
import { computerReleaseNotesQuery } from "./release-notes.query";

// Notes render the way a chat message does (same Markdown dialect, sanitizing and typography). The
// renderer loads when the dialog first opens, so the Computers page does not carry it.
const MessageBody = lazy(() =>
  import("#src/features/conversations/message-body").then((module) => ({
    default: module.MessageBody,
  })),
);

type ComputerRelease = NonNullable<Awaited<ReturnType<typeof getComputerReleaseNotes>>>;

/** The notes in the UI's language: Chinese for a Chinese UI, English otherwise, each falling back
 * to the other. */
function notesForLocale(notes: ComputerRelease["notes"], locale: string): string {
  return locale.startsWith("zh") ? notes["zh-CN"] || notes.en : notes.en || notes["zh-CN"];
}

/**
 * One Computer release's notes from the release catalog, or `undefined` while they load, when the
 * release has none, or when the read fails: "What's new" then simply does not show, and the
 * upgrade actions beside it never wait on it.
 */
export function useComputerRelease(version: string | undefined): ComputerRelease | undefined {
  return useQuery(computerReleaseNotesQuery(version)).data ?? undefined;
}

/** "What's new": a link that opens a release's notes in a dialog. */
export function ComputerReleaseNotesLink({ release }: { release: ComputerRelease }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" color="link-color" onPress={() => setOpen(true)}>
        {m.computer_upgrade_whats_new()}
      </Button>
      <ModalOverlay isOpen={open} onOpenChange={setOpen} isDismissable>
        <Modal className="w-[calc(100vw-2rem)] max-w-xl">
          <Dialog className="text-left">
            {({ close }) => (
              <>
                <div className="px-6 pt-6">
                  <Heading
                    slot="title"
                    className="text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                  >
                    {m.computer_upgrade_whats_new_title({ version: release.version })}
                  </Heading>
                </div>
                <div className="message-text mt-4 max-h-[60vh] overflow-y-auto px-6 text-primary">
                  <Suspense fallback={null}>
                    <MessageBody body={notesForLocale(release.notes, getLocale())} />
                  </Suspense>
                </div>
                <div className="flex justify-end px-6 py-4">
                  <Button type="button" size="sm" color="secondary" onPress={() => close()}>
                    {m.controls_close()}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
