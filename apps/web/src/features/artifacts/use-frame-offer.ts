import { useCallback, useEffect, useState, type RefObject } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { AnchorDraft, DraftTarget } from "./artifact-anchor-places";
import { useArtifactCommenting } from "./artifact-commenting";
import type { FrameRect, TrailStep } from "./artifact-page-annotations";
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
}): Offer {
  const { commenting } = useArtifactCommenting();
  const toast = useAppToast();
  const [selected, setSelected] = useState<{ key: string; draft: AnchorDraft } | null>(null);

  useEffect(() => {
    if (!commenting) setSelected(null);
  }, [commenting]);

  useEffect(() => {
    bridge.annotations.configure({
      picking: commenting,
      selecting: commenting,
      showMarks: commenting,
    });
  }, [bridge, commenting]);

  useEffect(
    () =>
      bridge.annotations.listen((event) => {
        switch (event.kind) {
          case "selected": {
            const origin = frame.current?.getBoundingClientRect();
            if (key === null || !origin) return;
            const placement: Placement = {
              rect: shifted(event.rect, origin),
              ...(event.point
                ? { at: { x: event.point.x + origin.left, y: event.point.y + origin.top } }
                : {}),
            };
            const draft = event.trail
              ? trailDraft(event.trail, event.trail.length - 1, placement, bridge)
              : { anchor: event.anchor, target: highlighted(placement, event.anchor, bridge) };
            setSelected({ key, draft });
            return;
          }
          case "unselected":
            if (!composing.current) setSelected(null);
            return;
          case "unanchorable":
            toast.notice(m.av_cm_pick_failed());
            return;
        }
      }),
    [bridge, frame, key, composing, toast],
  );

  const offered = selected && selected.key === key ? selected.draft : null;
  const onDismiss = useCallback(() => setSelected(null), []);
  return {
    offered,
    paintOffer: false,
    autoCompose: offered?.anchor.type === "element",
    onDismiss,
  };
}

type Placement = Pick<DraftTarget, "rect" | "at">;

function highlighted(
  placement: Placement,
  anchor: AnchorDraft["anchor"],
  bridge: PageBridge,
): DraftTarget {
  return { ...placement, highlight: (on) => bridge.annotations.setDraft(on ? anchor : null) };
}

function trailDraft(
  steps: readonly TrailStep[],
  at: number,
  placement: Placement,
  bridge: PageBridge,
): AnchorDraft {
  const { anchor } = steps[at]!;
  return {
    anchor,
    target: highlighted(placement, anchor, bridge),
    trail: {
      names: steps.map((step) => step.name),
      at,
      step: (index) => trailDraft(steps, index, placement, bridge),
    },
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
