import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Copy01, Download01 } from "@untitledui/icons";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
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
  sharePageMaxHeight,
  sharePages,
} from "./message-share-image-model";

type SharePage = { png: Blob; url: string };

/** The stage draws everything to measure it, then the pages to capture them; then it is gone. */
type ShareStep =
  | { name: "measuring"; width: number; chosen?: boolean }
  | { name: "capturing"; width: number; chosen?: boolean; split: number[][] }
  | { name: "ready"; width: number; pages: SharePage[] }
  | { name: "failed"; width: number; chosen?: boolean };

const START: ShareStep = { name: "measuring", width: SHARE_CARD_WIDTH };

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
  const [step, setStep] = useState<ShareStep>(START);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const root = stage.current;
    if (!root || step.name === "ready" || step.name === "failed") return;
    const { name, width: stageWidth, chosen } = step;
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
        const split = sharePages(slots, sharePageMaxHeight(stageWidth));
        // More than one narrow page, unless asked for: wider, so the same words take fewer pages.
        if (split.length > 1 && stageWidth === SHARE_CARD_WIDTH && !chosen)
          setStep({ name: "measuring", width: SHARE_CARD_WIDE_WIDTH });
        else setStep({ name: "capturing", width: stageWidth, chosen, split });
        return;
      }
      const pngs: Blob[] = [];
      for (const card of root.querySelectorAll<HTMLElement>("[data-share-page]")) {
        pngs.push(await shareCardPng(card, workspaceId));
        if (stale) return;
      }
      const pages = pngs.map((png) => ({ png, url: URL.createObjectURL(png) }));
      setStep({ name: "ready", pages, width: stageWidth });
    };
    run().catch(() => {
      if (!stale) setStep({ name: "failed", width: stageWidth, chosen });
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
  const { width } = step;
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
                  <Button
                    size="sm"
                    color="secondary"
                    onClick={() =>
                      setStep(
                        step.chosen
                          ? { name: "measuring", width: step.width, chosen: true }
                          : START,
                      )
                    }
                  >
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
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 safe-area-padding">
              <ButtonGroup
                size="sm"
                aria-label={m.message_share_format()}
                selectedKeys={[String(width)]}
                disallowEmptySelection
                onSelectionChange={(keys) => {
                  const picked = Number([...keys][0]);
                  if (picked === width) return;
                  setIndex(0);
                  setStep({ name: "measuring", width: picked, chosen: true });
                }}
              >
                <ButtonGroupItem id={String(SHARE_CARD_WIDTH)}>
                  {m.message_share_format_phone()}
                </ButtonGroupItem>
                <ButtonGroupItem id={String(SHARE_CARD_WIDE_WIDTH)}>
                  {m.message_share_format_desktop()}
                </ButtonGroupItem>
              </ButtonGroup>
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
                <Button
                  size="sm"
                  color="secondary"
                  iconLeading={Copy01}
                  isDisabled={!page}
                  onClick={() => void copy()}
                >
                  {m.message_share_copy()}
                </Button>
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
