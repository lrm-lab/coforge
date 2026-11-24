import { useCallback, type ReactNode } from "react";
import { m, useMotionValue } from "motion/react";

import { useEdgeSwipeBack } from "#src/hooks/use-edge-swipe-back";
import { DURATION_S, EASE_IN, EASE_OUT } from "#src/utils/motion-tokens";

export function SwipeableProfileOverlay({
  reduced,
  onBack,
  children,
}: {
  reduced: boolean;
  onBack: () => void;
  children: ReactNode;
}) {
  const swipeX = useMotionValue("0%");
  const handleProgress = useCallback(
    (progress: number) => {
      swipeX.jump(`${progress * 100}%`);
    },
    [swipeX],
  );
  const swipe = useEdgeSwipeBack({
    enabled: !reduced,
    onBack,
    onProgress: handleProgress,
  });

  return (
    <m.div
      {...swipe.bind}
      style={reduced ? undefined : { x: swipeX }}
      initial={reduced ? { opacity: 0 } : { x: "100%" }}
      animate={reduced ? { opacity: 1 } : swipe.dragging ? undefined : { x: "0%" }}
      exit={
        reduced
          ? { opacity: 0, transition: { duration: DURATION_S.reduced } }
          : { x: "100%", transition: { duration: DURATION_S.lgOut, ease: EASE_IN } }
      }
      transition={
        swipe.dragging
          ? { duration: 0 }
          : reduced
            ? { duration: DURATION_S.reduced }
            : swipe.settling
              ? { type: "spring", stiffness: 380, damping: 32 }
              : { duration: DURATION_S.lg, ease: EASE_OUT }
      }
      className="absolute inset-0 z-20 flex min-h-0 min-w-0 touch-pan-y flex-col bg-primary will-change-transform"
    >
      {children}
    </m.div>
  );
}
