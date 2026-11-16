import { useCallback, useEffect, useState, type RefObject } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { AnchorDraft } from "./artifact-anchor-places";
import { useArtifactCommenting } from "./artifact-commenting";
import type { FrameRect } from "./artifact-page-annotations";
import type { PageBridge } from "./artifact-page-bridge";
import type { Offer } from "./use-surface-offers";

export function useFrameOffer({
  bridge,
  frame,
  key,
  composing,
}: {
  bridge: PageBridge;
  frame: RefObject<HTMLIFrameElement | null>;
  key: string | null;
  composing: RefObject<boolean>;
}): Offer & { picking: boolean; togglePicking: () => void } {
  const { commenting } = useArtifactCommenting();
  const toast = useAppToast();
  const [picking, setPicking] = useState(true);
  const [selected, setSelected] = useState<{ key: string; draft: AnchorDraft } | null>(null);

  useEffect(() => {
    setPicking(true);
    if (!commenting) setSelected(null);
  }, [commenting]);

  useEffect(() => {
    bridge.annotations.configure({
      picking: commenting && picking,
      selecting: commenting,
      showMarks: commenting,
    });
  }, [bridge, commenting, picking]);

  useEffect(() => {
    if (!commenting || !picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commenting, picking]);

  useEffect(
    () =>
      bridge.annotations.listen((event) => {
        switch (event.kind) {
          case "selected": {
            const origin = frame.current?.getBoundingClientRect();
            if (key === null || !origin) return;
            const { anchor } = event;
            setSelected({
              key,
              draft: {
                anchor,
                target: {
                  rect: shifted(event.rect, origin),
                  highlight: (on) => bridge.annotations.setDraft(on ? anchor : null),
                },
              },
            });
            if (anchor.type === "element") setPicking(false);
            return;
          }
          case "unselected":
            if (!composing.current) setSelected(null);
            return;
          case "cancelled":
            setPicking(false);
            if (event.reason) toast.notice(m.av_cm_pick_failed());
            return;
        }
      }),
    [bridge, frame, key, composing, toast],
  );

  const offered = selected && selected.key === key ? selected.draft : null;
  const onDismiss = useCallback(() => setSelected(null), []);
  const togglePicking = useCallback(() => setPicking((on) => !on), []);
  return {
    offered,
    paintOffer: false,
    autoCompose: offered?.anchor.type === "element",
    onDismiss,
    picking,
    togglePicking,
  };
}

function shifted(rect: FrameRect, origin: DOMRect): FrameRect {
  return {
    top: rect.top + origin.top,
    bottom: rect.bottom + origin.top,
    left: rect.left + origin.left,
    right: rect.right + origin.left,
    width: rect.width,
    height: rect.height,
  };
}
