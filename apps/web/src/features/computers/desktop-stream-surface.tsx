import { useEffect, useEffectEvent, useRef, useState } from "react";
import { HotkeysProvider, useHotkeys } from "@tanstack/react-hotkeys";
import {
  Minimize01 as Minimize,
  SwitchHorizontal01 as Landscape,
  SwitchVertical01 as Portrait,
  XClose as X,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { withCloudDesktopPhoneView } from "./cloud-desktop-url";
import {
  DESKTOP_CHROME_AUTOHIDE_MS,
  desktopChromeAutoHides,
  desktopPhoneChromeInFab,
} from "./desktop-chrome-autohide";
import { desktopLandscapeFrameStyle } from "./desktop-landscape";
import { desktopShellActionFromMessage } from "./desktop-shell-message";
import type { EmbeddedDesktopPhase } from "./embedded-desktop-session";

export function DesktopStreamSurface({
  phase,
  url,
  title,
  miniBox,
  allowMinimize = true,
  onCollapse,
  onWake,
  onSleep,
}: {
  phase: Exclude<EmbeddedDesktopPhase, "sleeping">;
  url: string;
  title: string;
  miniBox: DOMRect | null;
  allowMinimize?: boolean;
  onCollapse: () => void;
  onWake: () => void;
  onSleep: () => void;
}) {
  const maximized = phase === "maximized";
  const phone = useMediaQuery("(max-width: 639px)", false);
  const portrait = useMediaQuery("(orientation: portrait)", false);
  const [landscape, setLandscape] = useState(false);
  const [chromeOpen, setChromeOpen] = useState(false);
  const [chromeIdleToken, setChromeIdleToken] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!maximized) setLandscape(false);
  }, [maximized]);

  useEffect(() => {
    if (landscape && (!portrait || !phone)) setLandscape(false);
  }, [landscape, portrait, phone]);

  const phoneFabChrome = desktopPhoneChromeInFab(phone, maximized);
  const autoHideChrome = !phoneFabChrome && desktopChromeAutoHides(landscape);

  useEffect(() => {
    if (autoHideChrome) setChromeOpen(false);
  }, [autoHideChrome]);

  const hideChrome = useEffectEvent(() => setChromeOpen(false));

  useEffect(() => {
    if (!autoHideChrome || !chromeOpen) return;
    const id = window.setTimeout(() => hideChrome(), DESKTOP_CHROME_AUTOHIDE_MS);
    return () => window.clearTimeout(id);
  }, [autoHideChrome, chromeOpen, chromeIdleToken, hideChrome]);

  const bumpChromeIdle = () => setChromeIdleToken((n) => n + 1);

  const showLandscapeToggle = maximized && phone && (portrait || landscape);
  const toggleLandscape = useEffectEvent(() => {
    if (!showLandscapeToggle) return;
    setLandscape((on) => !on);
  });
  const collapseDesktop = useEffectEvent(() => {
    if (allowMinimize) onCollapse();
  });

  useEffect(() => {
    if (!phoneFabChrome) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const action = desktopShellActionFromMessage(event.data);
      if (!action) return;
      if (action === "minimize") {
        collapseDesktop();
        return;
      }
      if (action === "sleep") {
        onSleep();
        return;
      }
      toggleLandscape();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [phoneFabChrome, collapseDesktop, onSleep, toggleLandscape]);

  const streamUrl = phone ? withCloudDesktopPhoneView(url) : url;
  const frameStyle =
    maximized && landscape
      ? desktopLandscapeFrameStyle()
      : maximized || !miniBox
        ? undefined
        : {
            top: miniBox.top,
            left: miniBox.left,
            width: miniBox.width,
            height: miniBox.height,
          };

  const chromeBar =
    maximized && !phoneFabChrome ? (
      <div
        className={cx(
          "flex shrink-0 items-center justify-between gap-2 border-b border-secondary bg-primary px-3 py-2",
          autoHideChrome && "absolute inset-x-0 top-0 z-10",
        )}
        onPointerDown={autoHideChrome ? bumpChromeIdle : undefined}
      >
        <p className="min-w-0 truncate text-sm font-medium text-primary">{title}</p>
        <div className="flex shrink-0 items-center gap-1">
          {showLandscapeToggle ? (
            <ButtonUtility
              size="sm"
              color="tertiary"
              icon={landscape ? Portrait : Landscape}
              tooltip={landscape ? m.computer_desktop_portrait() : m.computer_desktop_landscape()}
              aria-label={
                landscape ? m.computer_desktop_portrait() : m.computer_desktop_landscape()
              }
              onClick={() => setLandscape((on) => !on)}
            />
          ) : null}
          {allowMinimize ? (
            <ButtonUtility
              size="sm"
              color="tertiary"
              icon={Minimize}
              tooltip={m.computer_desktop_minimize()}
              aria-label={m.computer_desktop_minimize()}
              onClick={onCollapse}
            />
          ) : null}
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
    ) : null;

  return (
    <HotkeysProvider scope="embedded-desktop" exclusive={{ allow: ["global"] }}>
      <DesktopHotkeys
        maximized={maximized}
        onCollapse={allowMinimize ? onCollapse : onSleep}
        onSleep={onSleep}
      />
      <div
        className={cx(
          "overflow-hidden bg-primary",
          maximized
            ? landscape
              ? `${OVERLAY_LAYER} flex flex-col`
              : `fixed inset-0 ${OVERLAY_LAYER} flex flex-col safe-area-padding`
            : cx(
                `fixed ${OVERLAY_LAYER} rounded-md border border-secondary shadow-lg`,
                !miniBox && "pointer-events-none invisible",
              ),
        )}
        style={frameStyle}
        role={maximized ? "dialog" : undefined}
        aria-modal={maximized ? true : undefined}
        aria-label={title}
      >
        {maximized && !autoHideChrome ? chromeBar : null}
        {maximized && autoHideChrome && chromeOpen ? chromeBar : null}
        {maximized && autoHideChrome && !chromeOpen ? (
          <Button
            type="button"
            size="sm"
            color="tertiary"
            aria-label={m.computer_desktop_show_controls()}
            onPress={() => {
              setChromeOpen(true);
              bumpChromeIdle();
            }}
            className="absolute inset-x-0 top-0 z-10 flex h-11 items-start justify-center rounded-none p-0 pt-1.5 before:rounded-none"
          >
            <span className="h-1 w-10 rounded-full bg-fg-quaternary" aria-hidden="true" />
          </Button>
        ) : null}
        <div className={cx("relative min-h-0", maximized ? "flex-1" : "h-full w-full")}>
          <iframe
            ref={iframeRef}
            aria-label={title}
            src={streamUrl}
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
