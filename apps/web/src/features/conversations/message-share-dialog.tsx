import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Heading } from "react-aria-components";
import { ChevronLeft, ChevronRight, Copy01, Download01, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { Spinner } from "#src/components/ui/spinner";
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
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
  SHARE_CARD_WIDTH,
  SHARE_RATIOS,
  type ShareRatio,
  type ShareViewport,
  sharePageMaxHeight,
  shareRatioSize,
  shareSplitPages,
  shouldOfferMergeLong,
} from "./message-share-image-model";
import { ShareZoomHeaderControls, ShareZoomMobileBar } from "./message-share-zoom-controls";
import { ShareZoomStage } from "./message-share-zoom-stage";
import { useMessageShareZoom } from "./use-message-share-zoom";

type SharePage = { png: Blob; url: string; width: number; height: number };

type ShareStep = { ratio: ShareRatio; viewport: ShareViewport; width: number } & (
  | { name: "measuring" }
  | { name: "capturing"; split: number[][] }
  | { name: "ready"; pages: SharePage[] }
  | { name: "failed" }
);

function startStep(ratio: ShareRatio, viewport: ShareViewport, messageCount: number): ShareStep {
  const { width } = shareRatioSize(ratio, viewport);
  if (ratio === "long") {
    return {
      name: "capturing",
      ratio,
      viewport,
      width,
      split: shareSplitPages(
        "long",
        Array.from({ length: messageCount }, () => 1),
        0,
      ),
    };
  }
  return { name: "measuring", ratio, viewport, width };
}

function pageMaxHeight(
  ratio: ShareRatio,
  width: number,
  viewport: ShareViewport,
  stage: HTMLElement,
  rowsHeight: number,
) {
  const { height } = shareRatioSize(ratio, viewport);
  const card = stage.querySelector<HTMLElement>("[data-share-page]");
  if (height === undefined || !card) return sharePageMaxHeight(width);
  return height - (card.offsetHeight - rowsHeight);
}

function ratioLabel(ratio: ShareRatio): string {
  if (ratio === "auto") return m.message_share_ratio_auto();
  if (ratio === "long") return m.message_share_ratio_long();
  return ratio;
}

const noopSubscribe = () => () => {};
const readDocumentBody = () => document.body;
const serverDocumentBody = () => null;

export function MessageShareDialog({
  messages,
  onClose,
}: {
  messages: readonly MessageView[];
  onClose: () => void;
}) {
  const portalRoot = useSyncExternalStore(noopSubscribe, readDocumentBody, serverDocumentBody);
  const controlSize = useDialogControlSize();
  const desktop = useBreakpoint("sm");
  const viewport: ShareViewport = desktop ? "desktop" : "phone";
  const reduced = usePrefersReducedMotion();
  const toast = useAppToast();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const stage = useRef<HTMLDivElement>(null);
  const pendingMergedToastRef = useRef(false);
  const [step, setStep] = useState<ShareStep>(() => startStep("auto", viewport, messages.length));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if ((step.ratio === "auto" || step.ratio === "long") && step.viewport !== viewport) {
      setIndex(0);
      setStep(startStep(step.ratio, viewport, messages.length));
    }
  }, [messages.length, step.ratio, step.viewport, viewport]);

  useEffect(() => {
    const root = stage.current;
    if (!root || step.name === "ready" || step.name === "failed") return;
    const { name, ratio, viewport: stepViewport, width: stageWidth } = step;
    let stale = false;
    const run = async () => {
      await shareContentReady(root);
      if (stale) return;
      if (name === "measuring") {
        const rows = [...root.querySelectorAll<HTMLElement>("[data-share-row]")];
        const slots = rows.map(
          (row, at) =>
            (rows[at + 1]?.offsetTop ?? row.offsetTop + row.offsetHeight) - row.offsetTop,
        );
        const rowsHeight = slots.reduce((sum, slot) => sum + slot, 0);
        const split = shareSplitPages(
          ratio,
          slots,
          pageMaxHeight(ratio, stageWidth, stepViewport, root, rowsHeight),
        );
        setStep({ name: "capturing", ratio, viewport: stepViewport, width: stageWidth, split });
        return;
      }
      const pages: SharePage[] = [];
      for (const card of root.querySelectorAll<HTMLElement>("[data-share-page]")) {
        const png = await shareCardPng(card, workspaceId);
        if (stale) return;
        pages.push({
          png,
          url: URL.createObjectURL(png),
          width: card.offsetWidth,
          height: card.offsetHeight,
        });
      }
      setStep({ name: "ready", ratio, viewport: stepViewport, pages, width: stageWidth });
    };
    run().catch(() => {
      if (!stale) setStep({ name: "failed", ratio, viewport: stepViewport, width: stageWidth });
    });
    return () => {
      stale = true;
    };
  }, [step, workspaceId]);

  useEffect(() => {
    if (step.name !== "ready") return;
    if (step.ratio === "long" && pendingMergedToastRef.current) {
      pendingMergedToastRef.current = false;
      toast.success(m.message_share_merged_long());
    }
    return () => {
      for (const { url } of step.pages) URL.revokeObjectURL(url);
    };
  }, [step, toast]);

  const pages = step.name === "ready" ? step.pages : [];
  const { ratio, width } = step;
  const total = pages.length;
  const page = pages[index];
  const showMergeLong = shouldOfferMergeLong(ratio, total);
  const {
    stageContainerRef,
    zoomRef,
    displayScale,
    setDisplayScale,
    isPanning,
    setIsPanning,
    measuredStageSize,
    preferredStageHeight,
    overviewScale,
    canOverview,
    isOverview,
    stepZoom,
    resetZoom,
    toggleOverview,
  } = useMessageShareZoom({
    page,
    fallbackWidth: width,
    desktop,
    reduced,
    stepName: step.name,
    index,
    total,
    onIndexChange: setIndex,
  });

  const mergeToLong = () => {
    pendingMergedToastRef.current = true;
    setIndex(0);
    setStep(startStep("long", viewport, messages.length));
  };

  const copy = async () => {
    if (!page) return;
    if (await copySharePage(page.png)) toast.success(m.message_share_copied());
    else toast.error(m.message_share_copy_failed());
  };

  return (
    <>
      <ModalOverlay
        isOpen
        isDismissable
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Modal
          className={cn("w-full", width === SHARE_CARD_WIDTH ? "sm:max-w-120" : "sm:max-w-180")}
        >
          <Dialog className="flex max-h-[inherit] flex-col overflow-y-auto text-left">
            <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 pb-3">
              <Heading slot="title" className="text-lg font-semibold text-primary">
                {m.message_share_title()}
              </Heading>
              <div className="flex items-center gap-1">
                {page && (
                  <ShareZoomHeaderControls
                    scale={displayScale}
                    overviewScale={overviewScale}
                    canOverview={canOverview}
                    isOverview={isOverview}
                    onZoomIn={() => stepZoom("in")}
                    onZoomOut={() => stepZoom("out")}
                    onReset={() => resetZoom()}
                    onToggleOverview={toggleOverview}
                  />
                )}
                <ButtonUtility
                  type="button"
                  data-dialog-close
                  aria-label={m.controls_close()}
                  icon={XClose}
                  size="sm"
                  color="tertiary"
                  onClick={onClose}
                />
              </div>
            </div>
            <div
              ref={stageContainerRef}
              style={preferredStageHeight ? { height: preferredStageHeight } : undefined}
              className={cn(
                "relative flex shrink items-center justify-center overflow-hidden border-y border-secondary bg-secondary",
                page ? "min-h-0 sm:min-h-32" : "min-h-24 sm:min-h-48",
              )}
            >
              {page ? (
                <div className="absolute inset-0">
                  <ShareZoomStage
                    page={page}
                    alt={m.message_share_page_alt({ page: index + 1, total })}
                    zoomRef={zoomRef}
                    reduced={reduced}
                    desktop={desktop}
                    stageSize={measuredStageSize}
                    overviewScale={overviewScale}
                    canOverview={canOverview}
                    displayScale={displayScale}
                    isPanning={isPanning}
                    onScaleChange={setDisplayScale}
                    onPanningChange={setIsPanning}
                  />
                </div>
              ) : step.name === "failed" ? (
                <div className="flex flex-col items-center gap-3">
                  <p role="alert" className="text-sm text-secondary">
                    {m.message_share_failed()}
                  </p>
                  <Button
                    size="sm"
                    color="secondary"
                    onPress={() => setStep(startStep(ratio, viewport, messages.length))}
                  >
                    {m.message_share_retry()}
                  </Button>
                </div>
              ) : (
                <span className="text-tertiary" aria-label={m.message_share_generating()}>
                  <Spinner className="size-5" />
                </span>
              )}
            </div>
            {page && (
              <ShareZoomMobileBar
                scale={displayScale}
                overviewScale={overviewScale}
                canOverview={canOverview}
                isOverview={isOverview}
                onZoomIn={() => stepZoom("in")}
                onZoomOut={() => stepZoom("out")}
                onReset={() => resetZoom()}
                onToggleOverview={toggleOverview}
              />
            )}
            {page && showMergeLong && (
              <div
                data-share-merge-banner=""
                className="flex shrink-0 items-center justify-between gap-2 border-b border-secondary bg-secondary_alt px-4 py-1.5 sm:hidden"
              >
                <span className="text-xs text-secondary tabular-nums">
                  {m.message_share_multi_page_hint({ total })}
                </span>
                <Button
                  size="sm"
                  color="secondary"
                  className="min-h-11 shrink-0"
                  onPress={mergeToLong}
                >
                  {m.message_share_merge_long()}
                </Button>
              </div>
            )}
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3 safe-area-padding">
              <Select
                aria-label={m.message_share_ratio()}
                size={controlSize}
                className="w-24 sm:w-26"
                selectedKey={ratio}
                onSelectionChange={(key) => {
                  const picked = SHARE_RATIOS.find((each) => each === key);
                  if (!picked || picked === ratio) return;
                  pendingMergedToastRef.current = false;
                  setIndex(0);
                  setStep(startStep(picked, viewport, messages.length));
                }}
              >
                {SHARE_RATIOS.map((each) => (
                  <Select.Item key={each} id={each} label={ratioLabel(each)} />
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
                  <span
                    aria-live="polite"
                    className="whitespace-nowrap"
                  >{`${index + 1} / ${total}`}</span>
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
              {page && showMergeLong && (
                <Button
                  size="sm"
                  color="secondary"
                  className="hidden sm:inline-flex"
                  onPress={mergeToLong}
                >
                  {m.message_share_merge_long()}
                </Button>
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
                  onPress={() => void downloadSharePages(pages.map(({ png }) => png))}
                >
                  {total > 1 ? m.message_share_download_all() : m.message_share_download()}
                </Button>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
      {portalRoot &&
        (step.name === "measuring" || step.name === "capturing") &&
        createPortal(
          <div ref={stage} inert aria-hidden="true" className="fixed top-0 -left-[10000px]">
            {step.name === "capturing" ? (
              step.split.map((rows) => (
                <MessageShareCard
                  key={rows[0]}
                  width={step.width}
                  height={shareRatioSize(step.ratio, step.viewport).height}
                  messages={rows.flatMap((row) => messages[row] ?? [])}
                />
              ))
            ) : (
              <MessageShareCard width={step.width} messages={messages} />
            )}
          </div>,
          portalRoot,
        )}
    </>
  );
}
