import { useEffect, useRef, useState } from "react";
import { HotkeysProvider, useHotkeys } from "@tanstack/react-hotkeys";
import { Minus, Plus, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { scaleImageZoom } from "./report-present";

const IMAGE_ZOOM_OPEN = "reportImageZoom";

export function ReportImageZoom({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset[IMAGE_ZOOM_OPEN] = "open";
    const scroller = scrollerRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setScale((current) => scaleImageZoom(current, event.deltaY < 0 ? "in" : "out"));
    };
    scroller?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      delete document.documentElement.dataset[IMAGE_ZOOM_OPEN];
      scroller?.removeEventListener("wheel", onWheel);
    };
  }, []);
  const zoom = (direction: "in" | "out") =>
    setScale((current) => scaleImageZoom(current, direction));

  return (
    <ModalOverlay
      isOpen
      isDismissable
      instant
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="items-stretch bg-overlay/80 p-0 sm:items-stretch sm:p-0 [--modal-pb:0px] [--modal-pt:0px] sm:[--modal-pb:0px] sm:[--modal-pt:0px]"
    >
      <Modal className="h-dvh max-h-none w-full max-w-none rounded-none bg-transparent shadow-none ring-0 sm:rounded-none">
        <Dialog
          aria-label={alt || m.records_report_image_zoom_in()}
          className="flex h-full flex-col overflow-hidden safe-area-padding"
        >
          <HotkeysProvider scope="report-image-zoom" exclusive={{ allow: ["global"] }}>
            <ZoomKeys onZoom={zoom} />
            <div className="flex shrink-0 items-center justify-end gap-1 border-b border-secondary bg-primary px-4 py-3">
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={Minus}
                tooltip={m.records_report_image_zoom_out()}
                aria-label={m.records_report_image_zoom_out()}
                onClick={() => zoom("out")}
              />
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={Plus}
                tooltip={m.records_report_image_zoom_in()}
                aria-label={m.records_report_image_zoom_in()}
                onClick={() => zoom("in")}
              />
              <Button size="sm" color="tertiary" onPress={() => setScale(1)}>
                {m.records_report_image_zoom_reset()}
              </Button>
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={X}
                tooltip={m.records_report_image_zoom_close()}
                aria-label={m.records_report_image_zoom_close()}
                onClick={onClose}
              />
            </div>
            <div
              ref={scrollerRef}
              onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
              }}
              className="min-h-0 flex-1 overflow-auto"
            >
              <div
                onClick={(event) => {
                  if (event.target === event.currentTarget) onClose();
                }}
                className="flex min-h-full items-center justify-center p-6"
              >
                <img
                  src={src}
                  alt={alt}
                  draggable={false}
                  style={
                    scale === 1
                      ? { maxHeight: "calc(100dvh - 5rem)", maxWidth: "100%" }
                      : { width: `${scale * 100}%`, maxWidth: "none" }
                  }
                  className="h-auto object-contain"
                />
              </div>
            </div>
          </HotkeysProvider>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function isReportImageZoomOpen(): boolean {
  return document.documentElement.dataset[IMAGE_ZOOM_OPEN] === "open";
}

function ZoomKeys({ onZoom }: { onZoom: (direction: "in" | "out") => void }) {
  useHotkeys(
    [
      { hotkey: "+", callback: () => onZoom("in") },
      { hotkey: "=", callback: () => onZoom("in") },
      { hotkey: "-", callback: () => onZoom("out") },
      { hotkey: "_", callback: () => onZoom("out") },
    ],
    { ignoreInputs: false, ignoreDefaultPrevented: false },
  );
  return null;
}
