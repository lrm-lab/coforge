import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Monitor01 as Monitor } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { captureElementRect, type SharedRect } from "#src/lib/shared-element-rect";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { getCloudDesktopOrigin } from "./cloud-desktop-origin.functions";
import { cloudDesktopUrl } from "./cloud-desktop-url";
import { DesktopStreamSurface } from "./desktop-stream-surface";
import {
  EMBEDDED_DESKTOP_IDLE_SLEEP_MS,
  embeddedDesktopIdleCountdownActive,
  embeddedDesktopStreamActive,
  reduceEmbeddedDesktop,
  type EmbeddedDesktopPhase,
} from "./embedded-desktop-session";

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
  const slotRef = useRef<HTMLDivElement>(null);
  const [miniBox, setMiniBox] = useState<DOMRect | null>(null);
  const [originRect, setOriginRect] = useState<SharedRect | null>(null);

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
    if (!embeddedDesktopIdleCountdownActive(phase)) return;
    const id = window.setTimeout(() => {
      setPhase((p) => reduceEmbeddedDesktop(p, "idleExpired"));
    }, EMBEDDED_DESKTOP_IDLE_SLEEP_MS);
    return () => window.clearTimeout(id);
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

  const captureSlot = () => {
    if (slotRef.current) setOriginRect(captureElementRect(slotRef.current));
  };

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
                captureSlot();
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
              originRect={originRect}
              onCollapse={() => {
                captureSlot();
                setPhase((p) => reduceEmbeddedDesktop(p, "collapse"));
              }}
              onWake={() => {
                captureSlot();
                setPhase((p) => reduceEmbeddedDesktop(p, "wake"));
              }}
              onSleep={() => setPhase((p) => reduceEmbeddedDesktop(p, "sleep"))}
            />,
            document.body,
          )
        : null}
    </>
  );
}
