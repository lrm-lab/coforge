import { useRef, useState } from "react";
import { Heading } from "react-aria-components";
import { XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";
import { WHATS_NEW_CONTENT } from "./whats-new-content";
import type { WhatsNewId } from "./whats-new-entries";

export function WhatsNewDialog({
  ids,
  open,
  onClose,
  base,
}: {
  ids: readonly WhatsNewId[];
  open: boolean;
  onClose: (seen: readonly WhatsNewId[]) => void;
  base?: string;
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
      <Modal className="w-full max-w-[36rem] overflow-hidden">
        <Dialog aria-label={m.whats_new_entry()}>
          {({ close }) => (
            <WhatsNewPages
              pages={ids}
              base={base}
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
  base,
  onReach,
  onDone,
}: {
  pages: readonly WhatsNewId[];
  base?: string;
  onReach: (index: number) => void;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const id = pages[index];
  if (!id) return null;
  const entry = WHATS_NEW_CONTENT[id];
  const Illustration = entry.illustration;
  const last = index >= pages.length - 1;
  const actionHref =
    last && base && entry.action ? localizeHref(`${base}${entry.action.path}`) : undefined;
  const go = (to: number) => {
    setIndex(to);
    onReach(to);
  };
  return (
    <div className="relative flex flex-col">
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="tertiary"
        aria-label={m.whats_new_close()}
        onClick={onDone}
        className={cx(
          "absolute top-4 right-4 z-10 rounded-full",
          entry.heroTone === "dark" &&
            "bg-overlay/30 text-white/90 ring-1 ring-white/15 backdrop-blur-sm hover:bg-overlay/50 hover:text-white",
        )}
      />
      <div
        aria-hidden="true"
        className="relative h-56 overflow-hidden bg-secondary sm:h-[20.25rem]"
      >
        <Illustration />
      </div>
      <div className="px-5 pt-5 pb-5 sm:px-7 sm:pt-6 sm:pb-7">
        <Heading slot="title" className="text-lg font-semibold text-primary sm:text-xl">
          {entry.title()}
        </Heading>
        <p className="mt-2 text-md text-tertiary">{entry.body()}</p>
        <div className="mt-6 flex items-center gap-2">
          {pages.length > 1 && (
            <div className="flex items-center gap-1.5" aria-hidden="true">
              {pages.map((each, at) => (
                <span
                  key={each}
                  className={cx(
                    "h-1.5 rounded-full transition-[width,background-color] duration-(--duration-sm) ease-in-out",
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
              color={last && !actionHref ? "primary" : "secondary"}
              onClick={() => (last ? onDone() : go(index + 1))}
            >
              {last ? m.whats_new_got_it() : m.whats_new_next()}
            </Button>
            {actionHref && entry.action && (
              <Button size="sm" color="primary" href={actionHref} onPress={onDone}>
                {entry.action.label()}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
