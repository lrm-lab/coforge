import { HotkeysProvider, useHotkeys } from "@tanstack/react-hotkeys";
import { Minimize01 as Minimize, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import type { EmbeddedDesktopPhase } from "./embedded-desktop-session";

export function DesktopStreamSurface({
  phase,
  url,
  title,
  miniBox,
  onCollapse,
  onWake,
  onSleep,
}: {
  phase: Exclude<EmbeddedDesktopPhase, "sleeping">;
  url: string;
  title: string;
  miniBox: DOMRect | null;
  onCollapse: () => void;
  onWake: () => void;
  onSleep: () => void;
}) {
  const maximized = phase === "maximized";
  const style =
    maximized || !miniBox
      ? undefined
      : {
          top: miniBox.top,
          left: miniBox.left,
          width: miniBox.width,
          height: miniBox.height,
        };

  return (
    <HotkeysProvider scope="embedded-desktop" exclusive={{ allow: ["global"] }}>
      <DesktopHotkeys maximized={maximized} onCollapse={onCollapse} onSleep={onSleep} />
      <div
        className={cx(
          "overflow-hidden bg-primary",
          maximized
            ? `fixed inset-0 ${OVERLAY_LAYER} flex flex-col safe-area-padding`
            : cx(
                `fixed ${OVERLAY_LAYER} rounded-md border border-secondary shadow-lg`,
                !miniBox && "pointer-events-none invisible",
              ),
        )}
        style={style}
        role={maximized ? "dialog" : undefined}
        aria-modal={maximized ? true : undefined}
        aria-label={title}
      >
        {maximized ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-secondary px-3 py-2">
            <p className="min-w-0 truncate text-sm font-medium text-primary">{title}</p>
            <div className="flex shrink-0 items-center gap-1">
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={Minimize}
                tooltip={m.computer_desktop_minimize()}
                aria-label={m.computer_desktop_minimize()}
                onClick={onCollapse}
              />
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={X}
                tooltip={m.computer_desktop_sleep()}
                aria-label={m.computer_desktop_sleep()}
                onClick={onSleep}
              />
            </div>
          </div>
        ) : null}
        <div className={cx("relative min-h-0", maximized ? "flex-1" : "h-full w-full")}>
          <iframe
            aria-label={title}
            src={url}
            className="absolute inset-0 h-full w-full border-0 bg-black"
            allow="clipboard-read; clipboard-write"
          />
          {!maximized ? (
            <Button
              type="button"
              size="sm"
              color="tertiary"
              aria-label={m.computer_desktop_wake()}
              onPress={onWake}
              className="absolute inset-0 h-full w-full rounded-none p-0 before:rounded-none"
            />
          ) : null}
        </div>
      </div>
    </HotkeysProvider>
  );
}

function DesktopHotkeys({
  maximized,
  onCollapse,
  onSleep,
}: {
  maximized: boolean;
  onCollapse: () => void;
  onSleep: () => void;
}) {
  useHotkeys(
    [
      {
        hotkey: "Escape",
        callback: () => {
          if (maximized) onCollapse();
          else onSleep();
        },
      },
    ],
    { ignoreInputs: false, ignoreDefaultPrevented: false },
  );
  return null;
}
