import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";
import { ChevronLeft, ChevronRight, XClose } from "@untitledui/icons";
import { AnimatePresence, motion, useDragControls, useIsPresent } from "motion/react";
import { mergeProps, useToast, useToastRegion } from "react-aria";
import { Button as AriaButton } from "react-aria-components";
import type { QueuedToast, ToastState } from "react-stately";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { m } from "#src/paraglide/messages";

import { DURATION_S, EASE_IN, EASE_IN_OUT, EASE_OUT } from "#src/utils/motion-tokens";

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

export function shouldStartNoticeCardDrag(target: EventTarget | null): boolean {
  return !(
    target instanceof Element &&
    target.closest("button, a, input, select, textarea, [role='button']")
  );
}

function encodeNoticeDomId(id: string): string {
  return Array.from(id, (char) => (char.codePointAt(0) ?? 0).toString(36)).join("-");
}

export function NoticeCardHost() {
  const { notices, index, step } = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  const reduceMotion = usePrefersReducedMotion();
  const notice = notices[index];
  const coarse = useCoarsePointer();
  const [keepRegionMounted, setKeepRegionMounted] = useState(Boolean(notice));

  useEffect(() => {
    if (notice && !keepRegionMounted) setKeepRegionMounted(true);
  }, [notice, keepRegionMounted]);

  if (!notice && !keepRegionMounted) return null;

  return (
    <NoticeToastRegion
      notice={notice}
      index={index}
      count={notices.length}
      step={step}
      coarse={coarse}
      reduceMotion={reduceMotion}
      onExitComplete={() => {
        if (!state.notices.length) setKeepRegionMounted(false);
      }}
    />
  );
}

function NoticeToastRegion({
  notice,
  index,
  count,
  step,
  coarse,
  reduceMotion,
  onExitComplete,
}: {
  notice: SystemNotice | undefined;
  index: number;
  count: number;
  step: -1 | 0 | 1;
  coarse: boolean;
  reduceMotion: boolean;
  onExitComplete: () => void;
}) {
  const regionRef = useRef<HTMLElement>(null);

  const visibleToasts = useMemo<QueuedToast<SystemNotice>[]>(
    () => (notice ? [{ key: notice.id, content: notice }] : []),
    [notice],
  );
  const toastState = useMemo<ToastState<SystemNotice>>(
    () => ({
      visibleToasts,
      add: (content) => {
        appNotice.show(content);
        return content.id;
      },
      close: (key) => appNotice.dismiss(key),
      pauseAll: () => undefined,
      resumeAll: () => undefined,
    }),
    [visibleToasts],
  );
  const { regionProps } = useToastRegion(
    { "aria-label": m.notice_region() },
    toastState,
    regionRef,
  );

  const mergedRegionProps = mergeProps(regionProps, {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape" || !notice) return;
      event.preventDefault();
      event.stopPropagation();
      toastState.close(notice.id);
    },
  });

  return (
    /* Mounted only while a notice is visible or exiting so no idle fixed layer affects Safari 26+
       bar sampling, while keeping the toast region visible and focusable for F6 navigation and
       React Aria top-layer interaction over open modals. */
    <section
      {...mergedRegionProps}
      ref={regionRef}
      className="pointer-events-none fixed top-[calc(var(--spacing-safe-top)+3.75rem)] right-3 left-3 z-60 rounded-3xl outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2 sm:left-auto sm:w-[21.5rem]"
    >
      <AnimatePresence onExitComplete={onExitComplete}>
        {notice && visibleToasts[0] ? (
          <NoticeCard
            key="notice"
            notice={notice}
            queuedToast={visibleToasts[0]}
            toastState={toastState}
            index={index}
            count={count}
            step={step}
            coarse={coarse}
            reduceMotion={reduceMotion}
          />
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function NoticeCard({
  notice,
  queuedToast,
  toastState,
  index,
  count,
  step,
  coarse,
  reduceMotion,
}: {
  notice: SystemNotice;
  queuedToast: QueuedToast<SystemNotice>;
  toastState: ToastState<SystemNotice>;
  index: number;
  count: number;
  step: -1 | 0 | 1;
  coarse: boolean;
  reduceMotion: boolean;
}) {
  const dragControls = useDragControls();
  const cardRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const noticeDomKey = encodeNoticeDomId(notice.id);
  const activeTitleId = `${idPrefix}-title-${noticeDomKey}`;
  const activeDescriptionId = `${idPrefix}-desc-${noticeDomKey}`;
  const { toastProps, contentProps, titleProps, descriptionProps, closeButtonProps } = useToast(
    {
      toast: queuedToast,
      "aria-labelledby": activeTitleId,
      "aria-describedby": activeDescriptionId,
    },
    toastState,
    cardRef,
  );

  return (
    <motion.article
      key="notice"
      aria-label={notice.title}
      drag={coarse && !reduceMotion ? "x" : false}
      dragControls={dragControls}
      dragListener={false}
      dragSnapToOrigin
      onPointerDown={(event) => {
        if (!coarse || reduceMotion || !shouldStartNoticeCardDrag(event.target)) return;
        dragControls.start(event);
      }}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > SWIPE_DISMISS_PX) toastState.close(notice.id);
      }}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, x: 0, filter: "blur(0px)" }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: FADE }
          : { opacity: 0, x: 48, transition: { duration: DURATION_S.mdOut, ease: EASE_IN } }
      }
      transition={reduceMotion ? FADE : { duration: DURATION_S.md, ease: EASE_OUT }}
      className="group pointer-events-auto relative touch-pan-y rounded-3xl border border-secondary bg-primary p-3 shadow-(--toast-shadow)"
    >
      <div
        ref={cardRef}
        {...toastProps}
        className="rounded-2xl outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {count > 1 ? (
          <span
            aria-hidden
            className="absolute inset-x-3 -bottom-1.5 -z-10 h-6 rounded-b-2xl border border-t-0 border-secondary bg-secondary"
          />
        ) : null}
        <AriaButton
          {...closeButtonProps}
          aria-label={m.controls_close()}
          className="absolute -top-1.5 -left-1.5 z-10 grid size-6 place-items-center rounded-lg border border-secondary bg-primary text-fg-quaternary opacity-0 shadow-xs outline-focus-ring transition-opacity duration-150 group-hover:opacity-100 hover:text-fg-quaternary_hover focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 pointer-coarse:opacity-100 pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2"
        >
          <XClose aria-hidden className="size-3" />
        </AriaButton>
        <AnimatePresence initial={false} mode="popLayout" custom={step}>
          <NoticeCardSlide
            key={notice.id}
            notice={notice}
            toastState={toastState}
            index={index}
            count={count}
            step={step}
            reduceMotion={reduceMotion}
            contentProps={contentProps}
            titleProps={{ ...titleProps, id: activeTitleId }}
            descriptionProps={{ ...descriptionProps, id: activeDescriptionId }}
          />
        </AnimatePresence>
      </div>
    </motion.article>
  );
}

function NoticeCardSlide({
  notice,
  toastState,
  index,
  count,
  step,
  reduceMotion,
  contentProps,
  titleProps,
  descriptionProps,
}: {
  notice: SystemNotice;
  toastState: ToastState<SystemNotice>;
  index: number;
  count: number;
  step: -1 | 0 | 1;
  reduceMotion: boolean;
  contentProps: HTMLAttributes<HTMLElement>;
  titleProps: HTMLAttributes<HTMLElement>;
  descriptionProps: HTMLAttributes<HTMLElement>;
}) {
  const isPresent = useIsPresent();
  const { id: _exitingTitleId, ...exitingTitleProps } = titleProps;
  const { id: _exitingDescId, ...exitingDescriptionProps } = descriptionProps;

  return (
    <motion.div
      custom={step}
      aria-hidden={!isPresent || undefined}
      inert={!isPresent}
      className={isPresent ? undefined : "pointer-events-none"}
      initial={
        reduceMotion ? { opacity: 0 } : { opacity: 0, x: step * 16, y: step === 0 ? -12 : 0 }
      }
      animate={{ opacity: 1, x: 0, y: 0 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: FADE }
          : {
              opacity: 0,
              x: step * -16,
              y: step === 0 ? 8 : 0,
              transition:
                step === 0
                  ? { duration: DURATION_S.smOut, ease: EASE_IN }
                  : { duration: DURATION_S.sm, ease: EASE_IN_OUT },
            }
      }
      transition={
        reduceMotion ? FADE : { duration: DURATION_S.sm, ease: step === 0 ? EASE_OUT : EASE_IN_OUT }
      }
    >
      <div className="flex gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-secondary">
          <CoForgeMark className="h-3.5" />
        </span>
        <div {...(isPresent ? contentProps : undefined)} className="min-w-0 flex-1">
          <p
            {...(isPresent ? titleProps : exitingTitleProps)}
            className="text-sm font-semibold text-primary"
          >
            {notice.title}
          </p>
          <p
            {...(isPresent ? descriptionProps : exitingDescriptionProps)}
            className="mt-0.5 line-clamp-3 text-sm text-secondary"
          >
            {notice.body}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {count > 1 ? (
          <div className="mr-auto flex items-center gap-1 text-xs text-tertiary tabular-nums">
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={ChevronLeft}
              tooltip={m.notice_previous()}
              isDisabled={!isPresent || index === 0}
              onClick={() => page(-1)}
            />
            <span>
              {m.notice_position({
                index: String(index + 1),
                count: String(count),
              })}
            </span>
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={ChevronRight}
              tooltip={m.notice_next()}
              isDisabled={!isPresent || index === count - 1}
              onClick={() => page(1)}
            />
          </div>
        ) : null}
        {notice.actions.map((action, position) => (
          <Button
            key={action.label}
            size="xs"
            color={position === notice.actions.length - 1 ? "primary" : "secondary"}
            isDisabled={!isPresent}
            onPress={() => {
              if (!isPresent) return;
              toastState.close(notice.id);
              action.onPress();
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </motion.div>
  );
}
