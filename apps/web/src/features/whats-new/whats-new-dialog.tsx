import { useRef, useState } from "react";
import { Heading } from "react-aria-components";
import { XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { WHATS_NEW_CONTENT } from "./whats-new-content";
import type { WhatsNewId } from "./whats-new-entries";

/**
 * The "What's new" dialog (task #516): one page per entry, a large picture, the title and a few
 * sentences, paged with Next and Back. Centred on a wide screen, at the bottom on a phone. When it
 * goes, by "Got it", the close button, Escape or a click outside, `onClose` gets the entries whose
 * page was reached. The caller keeps `ids` fixed while it is open.
 */
export function WhatsNewDialog({
  ids,
  open,
  onClose,
}: {
  ids: readonly WhatsNewId[];
  open: boolean;
  onClose: (seen: readonly WhatsNewId[]) => void;
}) {
  const reached = useRef(0);
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (next) return;
        onClose(ids.slice(0, reached.current + 1));
        reached.current = 0;
      }}
      isDismissable
    >
      <Modal className="w-full max-w-[30rem]">
        <Dialog aria-label={m.whats_new_entry()}>
          {({ close }) => (
            <WhatsNewPages
              pages={ids}
              onReach={(at) => (reached.current = Math.max(reached.current, at))}
              onDone={close}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function WhatsNewPages({
  pages,
  onReach,
  onDone,
}: {
  pages: readonly WhatsNewId[];
  onReach: (index: number) => void;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const id = pages[index];
  if (!id) return null;
  const entry = WHATS_NEW_CONTENT[id];
  const Illustration = entry.illustration;
  const last = index >= pages.length - 1;
  const go = (to: number) => {
    setIndex(to);
    onReach(to);
  };
  return (
    <div className="p-4 sm:p-5">
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="tertiary"
        aria-label={m.whats_new_close()}
        onClick={onDone}
        className="absolute top-6 right-6 z-10"
      />
      <div
        aria-hidden="true"
        className="h-52 overflow-hidden rounded-xl bg-secondary ring-1 ring-secondary ring-inset sm:h-60"
      >
        <Illustration />
      </div>
      <div className="mt-5 px-1">
        <Heading slot="title" className="text-lg font-semibold text-primary">
          {entry.title()}
        </Heading>
        <p className="mt-1.5 text-md text-tertiary">{entry.body()}</p>
      </div>
      <div className="mt-6 flex items-center gap-2 px-1">
        {pages.length > 1 && (
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {pages.map((each, at) => (
              <span
                key={each}
                className={cx(
                  "h-1.5 rounded-full transition-all duration-150",
                  at === index ? "w-3.5 bg-fg-secondary" : "w-1.5 bg-quaternary",
                )}
              />
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {index > 0 && (
            <Button size="sm" color="tertiary" onClick={() => go(index - 1)}>
              {m.whats_new_back()}
            </Button>
          )}
          <Button
            size="sm"
            color={last ? "primary" : "secondary"}
            onClick={() => (last ? onDone() : go(index + 1))}
          >
            {last ? m.whats_new_got_it() : m.whats_new_next()}
          </Button>
        </div>
      </div>
    </div>
  );
}
