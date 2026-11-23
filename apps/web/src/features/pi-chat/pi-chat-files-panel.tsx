import { useEffect, useState } from "react";
import { Button } from "#src/components/base/buttons/button";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { browserLocalStorage } from "#src/features/browser-local-storage";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { m } from "#src/paraglide/messages";
import { PiChatFiles } from "./pi-chat-files";
import type { ComponentProps } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

export function PiChatFilesPanel(props: ComponentProps<typeof PiChatFiles>) {
  const desktop = useMediaQuery("(min-width: 1024px)", false);
  const [width, setWidth] = useState(24);
  const storageKey = `pi-chat-files-width:${props.workspaceSlug}:${props.computerId}`;

  useHotkey(
    "Escape",
    () => {
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) === null) props.onClose();
    },
    { ignoreInputs: true, preventDefault: false },
  );

  useEffect(() => {
    const value = Number(browserLocalStorage()?.getItem(storageKey));
    setWidth(value >= 18 && value <= 48 ? value : 24);
  }, [storageKey]);
  const resize = (value: number) => {
    const next = Math.min(48, Math.max(18, value));
    setWidth(next);
    try {
      browserLocalStorage()?.setItem(storageKey, String(next));
    } catch {
      /* Storage may be full. */
    }
  };
  if (!desktop)
    return (
      <aside className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-secondary bg-primary">
        <PiChatFiles {...props} />
      </aside>
    );
  return (
    <aside
      className="relative flex min-h-0 max-w-[45%] shrink-0 border-l border-secondary bg-primary"
      style={{ width: `${width}rem` }}
    >
      <Button
        size="sm"
        color="tertiary"
        aria-label={m.pi_chat_files_resize()}
        className="absolute inset-y-0 -left-1 z-10 h-full min-h-0 w-2 cursor-col-resize rounded-none p-0"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            resize(
              (window.innerWidth - event.clientX) /
                parseFloat(getComputedStyle(document.documentElement).fontSize),
            );
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            resize(width + (event.key === "ArrowLeft" ? 1 : -1));
          }
        }}
      />
      <PiChatFiles {...props} />
    </aside>
  );
}
