import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { HotkeysProvider, useHotkeys } from "@tanstack/react-hotkeys";
import { Minimize01 as Minimize, Monitor01 as Monitor, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { getCloudDesktopOrigin } from "./cloud-desktop-origin.functions";
import { cloudDesktopUrl } from "./cloud-desktop-url";
import {
  EMBEDDED_DESKTOP_IDLE_SLEEP_MS,
  embeddedDesktopIdleCountdownActive,
  embeddedDesktopStreamActive,
  reduceEmbeddedDesktop,
  type EmbeddedDesktopPhase,
} from "./embedded-desktop-session";

/**
 * Agent profile Computer row: sleeping monitor thumbnail → same-page near-fullscreen
 * overlay on wake; collapse keeps the stream in the thumbnail until idle sleep.
 */
export function AgentDesktopThumbnail({
  computerId,
  agentId,
  kind,
  online,
  owned,
  title,
}: {
  computerId: string;
  agentId: string;
  kind: string;
  online: boolean;
  owned: boolean;
  title: string;
}) {
  const enabled = kind === "cloud" && owned;
  const loadOrigin = useServerFn(getCloudDesktopOrigin);
  const origin = useQuery({
    queryKey: ["cloud-desktop-origin"],
    queryFn: () => loadOrigin(),
    enabled,
    staleTime: 60_000,
  });
  const [phase, setPhase] = useState<EmbeddedDesktopPhase>("sleeping");
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.ceil(EMBEDDED_DESKTOP_IDLE_SLEEP_MS / 1000),
  );
  const slotRef = useRef<HTMLDivElement>(null);
  const [miniBox, setMiniBox] = useState<DOMRect | null>(null);

  const url =
    enabled && origin.data ? cloudDesktopUrl(origin.data, computerId, agentId, title) : undefined;

  const syncMiniBox = useEffectEvent(() => {
    const el = slotRef.current;
    if (!el || phase !== "activeMini") {
      setMiniBox(null);
      return;
    }
    setMiniBox(el.getBoundingClientRect());
  });

  useEffect(() => {
    if (phase !== "activeMini") {
      setMiniBox(null);
      return;
    }
    syncMiniBox();
    const onScrollOrResize = () => syncMiniBox();
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [phase]);

  useEffect(() => {
    if (!embeddedDesktopIdleCountdownActive(phase)) {
      setSecondsLeft(Math.ceil(EMBEDDED_DESKTOP_IDLE_SLEEP_MS / 1000));
      return;
    }
    const started = Date.now();
    const tick = () => {
      const left = Math.max(
        0,
        Math.ceil((EMBEDDED_DESKTOP_IDLE_SLEEP_MS - (Date.now() - started)) / 1000),
      );
      setSecondsLeft(left);
      if (left === 0) setPhase((p) => reduceEmbeddedDesktop(p, "idleExpired"));
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "maximized") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [phase]);

  if (!enabled || !url) return null;

  const canWake = online && phase === "sleeping";
  const streamOn = embeddedDesktopStreamActive(phase);
  const wakeLabel = online ? m.computer_desktop_wake() : m.computer_desktop_offline();

  return (
    <>
      <div ref={slotRef} className="relative h-14 w-[5.5rem] shrink-0">
        {phase === "sleeping" ? (
          <Tooltip title={wakeLabel}>
            <Button
              type="button"
              size="sm"
              color="secondary"
              isDisabled={!canWake}
              aria-label={wakeLabel}
              onPress={() => {
                if (!canWake) return;
                setPhase((p) => reduceEmbeddedDesktop(p, "wake"));
              }}
              className={cx(
                "h-full w-full flex-col gap-0 overflow-hidden rounded-md p-0 before:rounded-md data-icon-only:p-0",
                canWake && "hover:border-brand",
              )}
            >
              <span className="flex h-3 w-full items-center justify-center gap-0.5 border-b border-secondary bg-tertiary/40 px-1">
                <span className="size-1 rounded-full bg-fg-quaternary" />
                <span className="size-1 rounded-full bg-fg-quaternary" />
                <span className="size-1 rounded-full bg-fg-quaternary" />
              </span>
              <span className="flex min-h-0 w-full flex-1 items-center justify-center text-fg-quaternary">
                <Monitor className="size-5" aria-hidden="true" />
              </span>
            </Button>
          </Tooltip>
        ) : (
          <div
            className="h-full w-full rounded-md border border-dashed border-secondary bg-secondary_alt"
            aria-hidden="true"
          />
        )}
      </div>
      {streamOn && phase !== "sleeping" && typeof document !== "undefined"
        ? createPortal(
            <DesktopStreamSurface
              phase={phase}
              url={url}
              title={title}
              miniBox={miniBox}
              secondsLeft={secondsLeft}
              onCollapse={() => setPhase((p) => reduceEmbeddedDesktop(p, "collapse"))}
              onWake={() => setPhase((p) => reduceEmbeddedDesktop(p, "wake"))}
              onSleep={() => setPhase((p) => reduceEmbeddedDesktop(p, "sleep"))}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function DesktopStreamSurface({
  phase,
  url,
  title,
  miniBox,
  secondsLeft,
  onCollapse,
  onWake,
  onSleep,
}: {
  phase: Exclude<EmbeddedDesktopPhase, "sleeping">;
  url: string;
  title: string;
  miniBox: DOMRect | null;
  secondsLeft: number;
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
              className="absolute inset-0 h-full w-full flex-col items-stretch justify-start rounded-none p-1 before:rounded-none"
            >
              <span className="rounded bg-primary/90 px-1 py-0.5 text-xs font-medium text-primary">
                {m.computer_desktop_sleeping_in({ seconds: secondsLeft })}
              </span>
            </Button>
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
