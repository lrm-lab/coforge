import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Copy01, Download01 } from "@untitledui/icons";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Spinner } from "#src/components/ui/spinner";
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { MessageView } from "./message-view";
import { MessageShareCard } from "./message-share-card";
import {
  copySharePage,
  downloadSharePages,
  shareCardPng,
  shareContentReady,
} from "./message-share-capture";
import {
  SHARE_CARD_WIDE_WIDTH,
  SHARE_CARD_WIDTH,
  SHARE_RATIOS,
  shareRatioSize,
  sharePageMaxHeight,
  sharePages,
  type ShareRatio,
} from "./message-share-image-model";

type SharePage = { png: Blob; url: string };

/** The stage draws everything to measure it, then the pages to capture them; then it is gone. */
type ShareStep = { ratio: ShareRatio; width: number } & (
  | { name: "measuring" }
  | { name: "capturing"; split: number[][] }
  | { name: "ready"; pages: SharePage[] }
  | { name: "failed" }
);

const start = (ratio: ShareRatio): ShareStep => ({
  name: "measuring",
  ratio,
  width: shareRatioSize(ratio).width,
});

/** The tallest run of messages a page of this `ratio` holds: for a fixed one, what the card's own
 * padding and foot leave of its height, from the card as measured with all `rowsHeight` of rows. */
function pageMaxHeight(ratio: ShareRatio, width: number, stage: HTMLElement, rowsHeight: number) {
  const { height } = shareRatioSize(ratio);
  const card = stage.querySelector<HTMLElement>("[data-share-page]");
  if (height === undefined || !card) return sharePageMaxHeight(width);
  return height - (card.offsetHeight - rowsHeight);
}

/**
 * "Share preview" (as Raft's): the selected messages drawn out of sight, split into pages by their
 * real height, captured once, and shown as the images they became, so what is previewed is what is
 * copied or downloaded.
 */
export function MessageShareDialog({
  messages,
  onClose,
}: {
  messages: readonly MessageView[];
  onClose: () => void;
}) {
  const toast = useAppToast();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const stage = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<ShareStep>(() => start("auto"));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const root = stage.current;
    if (!root || step.name === "ready" || step.name === "failed") return;
    const { name, ratio, width: stageWidth } = step;
    let stale = false;
    const run = async () => {
      await shareContentReady(root);
      if (stale) return;
      if (name === "measuring") {
        const rows = [...root.querySelectorAll<HTMLElement>("[data-share-row]")];
        // A row's slot, to the next row's top: the gap between rows counts towards a page.
        const slots = rows.map(
          (row, at) =>
            (rows[at + 1]?.offsetTop ?? row.offsetTop + row.offsetHeight) - row.offsetTop,
        );
        const rowsHeight = slots.reduce((sum, slot) => sum + slot, 0);
        const split = sharePages(slots, pageMaxHeight(ratio, stageWidth, root, rowsHeight));
        // More than one narrow page: wider, so the same words take fewer pages.
        if (split.length > 1 && ratio === "auto" && stageWidth === SHARE_CARD_WIDTH)
          setStep({ name: "measuring", ratio, width: SHARE_CARD_WIDE_WIDTH });
        else setStep({ name: "capturing", ratio, width: stageWidth, split });
        return;
      }
      const pngs: Blob[] = [];
      for (const card of root.querySelectorAll<HTMLElement>("[data-share-page]")) {
        pngs.push(await shareCardPng(card, workspaceId));
        if (stale) return;
      }
      const pages = pngs.map((png) => ({ png, url: URL.createObjectURL(png) }));
      setStep({ name: "ready", ratio, pages, width: stageWidth });
    };
    run().catch(() => {
      if (!stale) setStep({ name: "failed", ratio, width: stageWidth });
    });
    return () => {
      stale = true;
    };
  }, [step, workspaceId]);

  useEffect(() => {
    if (step.name !== "ready") return;
    return () => {
      for (const { url } of step.pages) URL.revokeObjectURL(url);
    };
  }, [step]);

  const pages = step.name === "ready" ? step.pages : [];
  const { ratio, width } = step;
  const total = pages.length;
  const page = pages[index];
  const copy = async () => {
    if (!page) return;
    if (await copySharePage(page.png)) toast.success(m.message_share_copied());
    else toast.error(m.message_share_copy_failed());
  };
  return (
    <>
      <ModalOverlay
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Modal
          className={cn("w-full", width === SHARE_CARD_WIDTH ? "sm:max-w-120" : "sm:max-w-180")}
        >
          <Dialog className="flex max-h-[inherit] flex-col overflow-hidden text-left">
            <DialogHeader
              title={m.message_share_title()}
              onClose={onClose}
              className="px-4 pt-4 pb-3"
            />
            <div className="flex min-h-48 flex-1 items-start justify-center overflow-y-auto border-y border-secondary bg-secondary">
              {page ? (
                <img
                  src={page.url}
                  alt={m.message_share_page_alt({ page: index + 1, total })}
                  style={{ maxWidth: width }}
                  className="w-full"
                />
              ) : step.name === "failed" ? (
                <div className="flex flex-col items-center gap-3 self-center">
                  <p role="alert" className="text-sm text-secondary">
                    {m.message_share_failed()}
                  </p>
                  <Button size="sm" color="secondary" onClick={() => setStep(start(ratio))}>
                    {m.message_share_retry()}
                  </Button>
                </div>
              ) : (
                <span
                  className="self-center text-tertiary"
                  aria-label={m.message_share_generating()}
                >
                  <Spinner className="size-5" />
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 px-4 py-3 safe-area-padding">
              <Select
                aria-label={m.message_share_ratio()}
                size="sm"
                className="w-24"
                selectedKey={ratio}
                onSelectionChange={(key) => {
                  const picked = SHARE_RATIOS.find((each) => each === key);
                  if (!picked || picked === ratio) return;
                  setIndex(0);
                  setStep(start(picked));
                }}
              >
                {SHARE_RATIOS.map((each) => (
                  <Select.Item
                    key={each}
                    id={each}
                    label={each === "auto" ? m.message_share_ratio_auto() : each}
                  />
                ))}
              </Select>
              {total > 1 && (
                <div className="flex items-center gap-1 text-sm text-secondary tabular-nums">
                  <ButtonUtility
                    size="sm"
                    color="tertiary"
                    icon={ChevronLeft}
                    aria-label={m.message_share_previous()}
                    isDisabled={index === 0}
                    onClick={() => setIndex(index - 1)}
                  />
                  <span aria-live="polite">{`${index + 1} / ${total}`}</span>
                  <ButtonUtility
                    size="sm"
                    color="tertiary"
                    icon={ChevronRight}
                    aria-label={m.message_share_next()}
                    isDisabled={index + 1 === total}
                    onClick={() => setIndex(index + 1)}
                  />
                </div>
              )}
              <div className="ml-auto flex items-center gap-2">
                <ButtonUtility
                  size="sm"
                  color="secondary"
                  icon={Copy01}
                  tooltip={m.message_share_copy()}
                  isDisabled={!page}
                  onClick={() => void copy()}
                />
                <Button
                  size="sm"
                  iconLeading={Download01}
                  isDisabled={!page}
                  onClick={() => void downloadSharePages(pages.map(({ png }) => png))}
                >
                  {total > 1 ? m.message_share_download_all() : m.message_share_download()}
                </Button>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
      {/* Out of sight, not hidden: a capture needs laid-out boxes. On the body, as the dialog's
          opening animation would scale everything inside it, and so what is measured and drawn. */}
      {(step.name === "measuring" || step.name === "capturing") &&
        createPortal(
          <div ref={stage} inert aria-hidden="true" className="fixed top-0 -left-[10000px]">
            {step.name === "capturing" ? (
              step.split.map((rows) => (
                <MessageShareCard
                  key={rows[0]}
                  width={step.width}
                  height={shareRatioSize(step.ratio).height}
                  messages={rows.flatMap((row) => messages[row] ?? [])}
                />
              ))
            ) : (
              <MessageShareCard width={step.width} messages={messages} />
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
