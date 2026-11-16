import { useEffect, useRef, useState } from "react";
import { HotkeysProvider, useHotkeys } from "@tanstack/react-hotkeys";
import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import { createPortal } from "react-dom";
import { Minus, Plus, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
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

  return createPortal(
    <HotkeysProvider scope="report-image-zoom" exclusive={{ allow: ["global"] }}>
      <ZoomKeys onClose={onClose} onZoom={zoom} />
      <div
        className={`fixed inset-0 ${OVERLAY_LAYER} flex flex-col bg-overlay/80 safe-area-padding`}
        role="dialog"
        aria-modal="true"
        aria-label={alt || m.records_report_image_zoom_in()}
      >
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-secondary bg-primary px-4 py-3">
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={Minus}
            aria-label={m.records_report_image_zoom_out()}
            onClick={() => zoom("out")}
          />
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={Plus}
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
            aria-label={m.records_report_image_zoom_close()}
            onClick={onClose}
          />
        </div>
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full items-center justify-center p-6">
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
      </div>
    </HotkeysProvider>,
    document.body,
  );
}

export function isReportImageZoomOpen(): boolean {
  return document.documentElement.dataset[IMAGE_ZOOM_OPEN] === "open";
}

function ZoomKeys({
  onClose,
  onZoom,
}: {
  onClose: () => void;
  onZoom: (direction: "in" | "out") => void;
}) {
  useHotkeys(
    [
      { hotkey: "Escape", callback: onClose },
      { hotkey: "+", callback: () => onZoom("in") },
      { hotkey: "=", callback: () => onZoom("in") },
      { hotkey: "-", callback: () => onZoom("out") },
      { hotkey: "_", callback: () => onZoom("out") },
    ],
    { ignoreInputs: false, ignoreDefaultPrevented: false },
  );
  return null;
}
