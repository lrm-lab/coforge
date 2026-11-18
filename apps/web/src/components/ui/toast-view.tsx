import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { AlertCircle, Check, InfoCircle, XClose } from "@untitledui/icons";
import { AnimatePresence, motion } from "motion/react";
import { Button as AriaButton } from "react-aria-components";

import { Spinner } from "#src/components/ui/spinner";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

import {
  countdownRemainingMs,
  pauseCountdown,
  resumeCountdown,
  startCountdown,
  SWIPE_DISMISS_PX,
  TOAST_FADE,
  type Countdown,
  type Toast,
  type ToastIcon,
} from "./toast-model";

const SETTLE_EASE = [0.25, 0.1, 0.25, 1] as const;
const RESIZE_EASE = [0.32, 0.72, 0, 1] as const;

function useCountdown(toast: Toast, held: boolean, onElapsed: () => void) {
  const countdown = useRef<Countdown | null>(null);
  const heldRef = useRef(held);
  const timer = useRef<number | undefined>(undefined);
  const elapsed = useLatestCallback(onElapsed);

  const arm = (next: Countdown) => {
    window.clearTimeout(timer.current);
    countdown.current = next;
    if (next.runningSince !== null)
      timer.current = window.setTimeout(elapsed, countdownRemainingMs(next, performance.now()));
  };

  useEffect(() => {
    if (!Number.isFinite(toast.durationMs)) {
      countdown.current = null;
      return;
    }
    const now = performance.now();
    const started = startCountdown(toast.durationMs, now);
    arm(heldRef.current ? pauseCountdown(started, now) : started);
    return () => window.clearTimeout(timer.current);
  }, [toast.id, toast.revision, toast.durationMs]);

  useEffect(() => {
    heldRef.current = held;
    if (!countdown.current) return;
    const now = performance.now();
    arm(held ? pauseCountdown(countdown.current, now) : resumeCountdown(countdown.current, now));
  }, [held]);

  return countdown;
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function usePageHidden() {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "hidden",
    () => false,
  );
}

function CountdownRing({
  countdown,
  durationMs,
}: {
  countdown: RefObject<Countdown | null>;
  durationMs: number;
}) {
  const read = () =>
    countdown.current ? countdownRemainingMs(countdown.current, performance.now()) : durationMs;
  const [remainingMs, setRemainingMs] = useState(read);
  useEffect(() => {
    const tick = window.setInterval(() => setRemainingMs(read()), 100);
    return () => window.clearInterval(tick);
  });
  const circumference = 2 * Math.PI * 10;
  const left = durationMs > 0 ? remainingMs / durationMs : 0;
  return (
    <span className="relative grid size-6 place-items-center">
      <svg aria-hidden viewBox="0 0 24 24" className="absolute inset-0 size-6 -rotate-90">
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          strokeWidth="2"
          className="stroke-border-secondary"
        />
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - left)}
          className="stroke-utility-brand-600"
        />
      </svg>
      <span className="text-xs font-semibold text-utility-brand-600 tabular-nums">
        {Math.ceil(remainingMs / 1000)}
      </span>
    </span>
  );
}

function IconTile({
  icon,
  countdown,
  durationMs,
}: {
  icon: ToastIcon;
  countdown: RefObject<Countdown | null>;
  durationMs: number;
}) {
  if (icon === "countdown") return <CountdownRing countdown={countdown} durationMs={durationMs} />;
  if (icon === "progress")
    return (
      <span className="grid size-6 place-items-center rounded-lg bg-utility-neutral-50">
        <Spinner className="size-4 text-fg-quaternary" />
      </span>
    );
  const tile = {
    done: { Icon: Check, className: "bg-utility-brand-50 text-utility-brand-600" },
    error: { Icon: AlertCircle, className: "bg-error-primary text-fg-error-primary" },
    notice: { Icon: InfoCircle, className: "bg-utility-neutral-50 text-utility-neutral-600" },
  }[icon];
  return (
    <span className={cx("grid size-6 place-items-center rounded-lg", tile.className)}>
      <tile.Icon aria-hidden className="size-3.5 stroke-[2.5px]" />
    </span>
  );
}

const controlClassName =
  "h-7 shrink-0 rounded-[0.625rem] outline-focus-ring transition-colors duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2";

export function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const reduceMotion = usePrefersReducedMotion();
  const coarsePointer = useCoarsePointer();
  const [pointerOver, setPointerOver] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const pageHidden = usePageHidden();
  const countdown = useCountdown(toast, pointerOver || focusWithin || pageHidden, onDismiss);
  const lineRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [lineWidth, setLineWidth] = useState<number>();

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
    setFocusWithin(false);
  }, [toast.revision]);

  useLayoutEffect(() => {
    if (lineRef.current) setLineWidth(lineRef.current.offsetWidth);
  }, [toast.revision, toast.title, toast.action?.label]);

  const width = lineWidth === undefined ? undefined : lineWidth + 2;

  return (
    <motion.div
      ref={rootRef}
      data-toast
      onPointerEnter={() => setPointerOver(true)}
      onPointerLeave={() => setPointerOver(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDismiss();
      }}
      drag={reduceMotion ? false : "x"}
      dragSnapToOrigin
      dragListener={coarsePointer}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > SWIPE_DISMISS_PX) onDismiss();
      }}
      initial={
        reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.96, filter: "blur(8px)" }
      }
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        filter: "blur(0px)",
        ...(width === undefined ? {} : { width }),
      }}
      exit={
        reduceMotion
          ? { opacity: 0, pointerEvents: "none", transition: TOAST_FADE }
          : {
              opacity: 0,
              pointerEvents: "none",
              y: -6,
              filter: "blur(6px)",
              transition: { duration: 0.22, ease: "easeIn" },
            }
      }
      transition={
        reduceMotion
          ? { ...TOAST_FADE, width: { duration: 0 } }
          : {
              duration: 0.5,
              ease: SETTLE_EASE,
              opacity: { duration: 0.4, ease: SETTLE_EASE },
              width: { duration: 0.38, ease: RESIZE_EASE },
            }
      }
      className="pointer-events-auto relative flex min-h-10 max-w-full touch-pan-y items-start overflow-hidden rounded-2xl border border-secondary bg-linear-to-b from-bg-primary to-bg-secondary shadow-(--toast-shadow)"
    >
      <span className="absolute top-[calc(0.5rem-1px)] left-[calc(0.5rem-1px)] size-6">
        <AnimatePresence initial={false}>
          <motion.span
            key={toast.icon}
            className="absolute inset-0"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, rotate: -40, scale: 0.5 }}
            animate={{ opacity: 1, rotate: 0, scale: 1, filter: "blur(0px)" }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, filter: "blur(4px)" }}
            transition={reduceMotion ? TOAST_FADE : { duration: 0.3, ease: RESIZE_EASE }}
          >
            <IconTile icon={toast.icon} countdown={countdown} durationMs={toast.durationMs} />
          </motion.span>
        </AnimatePresence>
      </span>
      <div className="relative min-w-0 flex-1">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={toast.revision}
            ref={lineRef}
            className={cx(
              "flex min-h-[calc(2.5rem-2px)] w-max max-w-[min(34.5rem,calc(100vw-2.5rem))] items-start gap-1 py-[calc(0.375rem-1px)] pl-[calc(2.5rem-1px)]",
              toast.action ? "pr-[calc(0.375rem-1px)]" : "pr-4",
            )}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 5, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -5, filter: "blur(4px)", transition: { duration: 0.18 } }
            }
            transition={
              reduceMotion ? TOAST_FADE : { delay: 0.1, duration: 0.3, ease: SETTLE_EASE }
            }
          >
            {/* Two lines at most: a narrow screen keeps the end of a title (often its point) instead of
                cutting it to one line. Top-aligned with 6px + 4px so one line sits where it did when
                the row was centred (less the 1px border), and the actions stay level with the first line. */}
            <span className="line-clamp-2 min-w-0 py-1 text-sm font-medium [overflow-wrap:anywhere] text-primary">
              {toast.title}
            </span>
            {toast.action ? (
              <>
                <AriaButton
                  onPress={toast.action.onClick}
                  className={cx(
                    controlClassName,
                    "ml-1 px-2.5 text-sm font-semibold text-utility-brand-600 hover:bg-utility-brand-50",
                  )}
                >
                  {toast.action.label}
                </AriaButton>
                <AriaButton
                  aria-label={m.controls_close()}
                  onPress={onDismiss}
                  className={cx(
                    controlClassName,
                    "grid size-7 place-items-center text-fg-quaternary hover:bg-primary_hover hover:text-fg-quaternary_hover",
                  )}
                >
                  <XClose aria-hidden className="size-4" />
                </AriaButton>
              </>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
      {toast.icon === "done" && !reduceMotion ? (
        <motion.span
          key={`sheen-${toast.revision}`}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-linear-to-r from-transparent via-(--toast-sheen) to-transparent"
          initial={{ x: "0%" }}
          animate={{ x: "320%" }}
          transition={{ duration: 0.9, ease: "easeOut", delay: 0.15 }}
        />
      ) : null}
    </motion.div>
  );
}
