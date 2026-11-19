import { useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, XClose } from "@untitledui/icons";
import { AnimatePresence, motion } from "motion/react";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { m } from "#src/paraglide/messages";

import { SWIPE_DISMISS_PX, TOAST_FADE as FADE } from "./toast-model";

type NoticeAction = { label: string; onPress: () => void };

type SystemNotice = { id: string; title: string; body: string; actions: NoticeAction[] };

type NoticeState = { notices: SystemNotice[]; index: number; step: -1 | 0 | 1 };

let state: NoticeState = { notices: [], index: 0, step: 0 };
const listeners = new Set<() => void>();

function update(next: NoticeState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const appNotice = {
  show(notice: SystemNotice) {
    const rest = state.notices.filter((shown) => shown.id !== notice.id);
    update({ notices: [notice, ...rest], index: 0, step: 0 });
  },
  dismiss(id: string) {
    const notices = state.notices.filter((shown) => shown.id !== id);
    update({ notices, index: Math.min(state.index, Math.max(0, notices.length - 1)), step: 1 });
  },
};

function page(step: -1 | 1) {
  const index = Math.min(state.notices.length - 1, Math.max(0, state.index + step));
  if (index !== state.index) update({ ...state, index, step });
}

const SLIDE_EASE = [0.23, 1, 0.32, 1] as const;

export function NoticeCardHost() {
  const { notices, index, step } = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  const reduceMotion = usePrefersReducedMotion();
  const notice = notices[index];
  const newest = notices[0];
  const coarse = useCoarsePointer();

  return (
    <section
      aria-label={m.notice_region()}
      className="pointer-events-none fixed top-[calc(var(--spacing-safe-top)+3.75rem)] right-3 left-3 z-60 sm:left-auto sm:w-[21.5rem]"
    >
      <p role="status" className="sr-only">
        {newest ? `${newest.title}. ${newest.body}` : ""}
      </p>
      <AnimatePresence>
        {notice ? (
          <motion.article
            key="notice"
            aria-label={notice.title}
            onKeyDown={(event) => {
              if (event.key === "Escape") appNotice.dismiss(notice.id);
            }}
            drag={coarse && !reduceMotion ? "x" : false}
            dragSnapToOrigin
            onDragEnd={(_, info) => {
              if (Math.abs(info.offset.x) > SWIPE_DISMISS_PX) appNotice.dismiss(notice.id);
            }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, x: 0, filter: "blur(0px)" }}
            exit={
              reduceMotion
                ? { opacity: 0, transition: FADE }
                : { opacity: 0, x: 48, transition: { duration: 0.22, ease: "easeOut" } }
            }
            transition={reduceMotion ? FADE : { duration: 0.28, ease: SLIDE_EASE }}
            className="group pointer-events-auto relative touch-pan-y rounded-3xl border border-secondary bg-primary p-3 shadow-(--toast-shadow)"
          >
            {notices.length > 1 ? (
              <span
                aria-hidden
                className="absolute inset-x-3 -bottom-1.5 -z-10 h-6 rounded-b-2xl border border-t-0 border-secondary bg-secondary"
              />
            ) : null}
            <AriaButton
              aria-label={m.controls_close()}
              onPress={() => appNotice.dismiss(notice.id)}
              className="absolute -top-1.5 -left-1.5 z-10 grid size-6 place-items-center rounded-lg border border-secondary bg-primary text-fg-quaternary opacity-0 shadow-xs outline-focus-ring transition-opacity duration-150 group-hover:opacity-100 hover:text-fg-quaternary_hover focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 pointer-coarse:opacity-100"
            >
              <XClose aria-hidden className="size-3" />
            </AriaButton>
            <AnimatePresence initial={false} mode="popLayout" custom={step}>
              <motion.div
                key={notice.id}
                custom={step}
                initial={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, x: step * 16, y: step === 0 ? -12 : 0 }
                }
                animate={{ opacity: 1, x: 0, y: 0 }}
                exit={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, x: step * -16, y: step === 0 ? 8 : 0 }
                }
                transition={reduceMotion ? FADE : { duration: 0.24, ease: SLIDE_EASE }}
              >
                <div className="flex gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-secondary">
                    <CoForgeMark className="h-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-primary">{notice.title}</p>
                    <p className="mt-0.5 line-clamp-3 text-sm text-secondary">{notice.body}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-end gap-2">
                  {notices.length > 1 ? (
                    <div className="mr-auto flex items-center gap-1 text-xs text-tertiary tabular-nums">
                      <ButtonUtility
                        size="xs"
                        color="tertiary"
                        icon={ChevronLeft}
                        tooltip={m.notice_previous()}
                        isDisabled={index === 0}
                        onClick={() => page(-1)}
                      />
                      <span>
                        {m.notice_position({
                          index: String(index + 1),
                          count: String(notices.length),
                        })}
                      </span>
                      <ButtonUtility
                        size="xs"
                        color="tertiary"
                        icon={ChevronRight}
                        tooltip={m.notice_next()}
                        isDisabled={index === notices.length - 1}
                        onClick={() => page(1)}
                      />
                    </div>
                  ) : null}
                  {notice.actions.map((action, position) => (
                    <Button
                      key={action.label}
                      size="xs"
                      color={position === notice.actions.length - 1 ? "primary" : "secondary"}
                      onPress={() => {
                        appNotice.dismiss(notice.id);
                        action.onPress();
                      }}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              </motion.div>
            </AnimatePresence>
          </motion.article>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
