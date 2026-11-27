import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentPropsWithRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { DismissButton, mergeProps, Overlay, useModalOverlay, useOverlay } from "react-aria";
import {
  OverlayTriggerStateContext,
  type ModalOverlay as AriaModalOverlay,
} from "react-aria-components";
import { useOverlayTriggerState, type OverlayTriggerState } from "react-stately";

import { Modal as OfficialModal } from "#src/components/application/modals/modal";
import { useKeyboardFieldFocused } from "#src/hooks/use-keyboard-field-focused";
import { useVisualViewportTop } from "#src/hooks/use-visual-viewport-top";
import {
  createOverlayHostElement,
  hasFollowingOverlayHost,
  hasPrecedingModalHost,
  OVERLAY_CONTENT_Z,
  OVERLAY_LAYER,
  OVERLAY_SCRIM_Z,
  useOverlayEnterAnimation,
  useOverlayExitAnimation,
  useOverlayHost,
} from "#src/lib/overlay-layer";
import { acquirePageFlowHandoff, isTopPageFlowEntry } from "#src/lib/page-flow-handoff";
import { cx } from "#src/utils/cx";
import {
  acquireOutsideInert,
  PageCoordinateScrim,
  resolveScrimConfig,
  useKeepFocusedFieldInView,
  useVisualViewportSize,
} from "./modal-scrim";

export { PageCoordinateScrim, resolveScrimConfig, useKeepFocusedFieldInView };

export type ModalForm = "sheet" | "page" | null;

export type ModalOverlayProps = Omit<
  ComponentProps<(props: ComponentPropsWithRef<typeof AriaModalOverlay>) => ReactNode>,
  "style"
> & {
  confirmation?: boolean;
  page?: boolean;
  instant?: boolean;
};

type PageModalContextValue = {
  modalRef: RefObject<HTMLDivElement | null>;
  modalProps: HTMLAttributes<HTMLDivElement>;
  isDismissable: boolean;
  pageFlow: boolean;
  isEnteredReady: boolean;
  isExiting: boolean;
  modalOnExitRef: RefObject<ModalOverlayProps["onExit"] | null>;
};

type ModalRenderState = { isEntering: boolean; isExiting: boolean; state: OverlayTriggerState };

function resolveRender<V, E extends Record<string, unknown>>(
  value: V | ((renderProps: ModalRenderState & E) => V),
  renderProps: ModalRenderState,
  extra: E,
): V {
  return typeof value === "function"
    ? (value as (arg: ModalRenderState & E) => V)({ ...renderProps, ...extra })
    : value;
}

export const ModalContext = createContext<{ form: ModalForm; instant: boolean }>({
  form: null,
  instant: false,
});

export const PageModalContext = createContext<PageModalContextValue | null>(null);

export function UnifiedPageModalOverlay({
  overlayState,
  wide,
  isEntering: propIsEntering,
  isExiting: propIsExiting,
  onEnter,
  onExit,
  UNSTABLE_portalContainer,
  ...rest
}: ModalOverlayProps & {
  overlayState: OverlayTriggerState;
  wide: boolean;
}) {
  const open = overlayState.isOpen;
  const [ownHost] = useState<HTMLDivElement | null>(() =>
    typeof document === "undefined" ? null : createOverlayHostElement(),
  );
  const portalTarget = UNSTABLE_portalContainer ?? ownHost;
  const layerRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const modalOnExitRef = useRef<ModalOverlayProps["onExit"] | null>(null);
  const triggerModalExit = useCallback(
    (element: HTMLElement) => modalOnExitRef.current?.(element),
    [],
  );
  const isOverlayExiting = useOverlayExitAnimation(layerRef, open, onExit);
  const isModalExiting = useOverlayExitAnimation(modalRef, open, triggerModalExit);
  const isExiting = isOverlayExiting || isModalExiting || Boolean(propIsExiting);
  const active = open || isExiting;
  const desiredPageFlow = !wide && (!active || !hasPrecedingModalHost(portalTarget));
  const [latchedPageFlow, setLatchedPageFlow] = useState(desiredPageFlow);
  const followingOverlay = active && hasFollowingOverlayHost(portalTarget);
  const usePhonePageFlow = followingOverlay ? latchedPageFlow : desiredPageFlow;
  if (!followingOverlay && latchedPageFlow !== desiredPageFlow) {
    setLatchedPageFlow(desiredPageFlow);
  }
  const { host, overlayRef } = useOverlayHost(
    open || Boolean(propIsExiting),
    usePhonePageFlow,
    ownHost,
  );
  const portalContainer = UNSTABLE_portalContainer ?? host;

  if ((!open && !isExiting) || typeof document === "undefined" || !portalContainer) return null;

  return (
    <UnifiedPageModalOverlayInner
      {...rest}
      open={open}
      isExiting={isExiting}
      isEntering={propIsEntering}
      onEnter={onEnter}
      overlayState={overlayState}
      usePhonePageFlow={usePhonePageFlow}
      portalContainer={portalContainer}
      layerRef={layerRef}
      modalRef={modalRef}
      modalOnExitRef={modalOnExitRef}
      overlayRef={overlayRef}
    />
  );
}

function UnifiedPageModalOverlayInner({
  className,
  instant = false,
  overlayState,
  open,
  isExiting,
  isEntering: propIsEntering,
  onEnter,
  usePhonePageFlow,
  portalContainer,
  layerRef,
  modalRef,
  modalOnExitRef,
  overlayRef,
  ref,
  children,
  isDismissable,
  isKeyboardDismissDisabled,
  shouldCloseOnInteractOutside,
}: ModalOverlayProps & {
  overlayState: OverlayTriggerState;
  open: boolean;
  isExiting: boolean;
  usePhonePageFlow: boolean;
  portalContainer: Element;
  layerRef: RefObject<HTMLDivElement | null>;
  modalRef: RefObject<HTMLDivElement | null>;
  modalOnExitRef: RefObject<ModalOverlayProps["onExit"] | null>;
  overlayRef: (node: HTMLElement | null) => void;
}) {
  const entryIdRef = useRef<symbol | null>(null);
  const onCloseRef = useRef(overlayState.close);
  onCloseRef.current = overlayState.close;
  const combinedOverlayRef = useCallback(
    (node: HTMLDivElement | null) => {
      layerRef.current = node;
      overlayRef(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [layerRef, overlayRef, ref],
  );

  const [isEnteredReady, setEnteredReady] = useState(false);
  useLayoutEffect(() => {
    setEnteredReady(true);
  }, []);
  const isOverlayEntering =
    useOverlayEnterAnimation(layerRef, isEnteredReady, onEnter) || Boolean(propIsEntering);

  const viewportTop = useVisualViewportTop(open && !usePhonePageFlow);
  const viewportSize = useVisualViewportSize(open && !usePhonePageFlow);
  const keyboardMayBeUp = useKeyboardFieldFocused(open && !usePhonePageFlow);
  const scrim = useMemo(() => resolveScrimConfig(className, instant), [className, instant]);
  const modalContext = useMemo<{ form: ModalForm; instant: boolean }>(
    () => ({ form: "page", instant }),
    [instant],
  );
  useKeepFocusedFieldInView(open && !usePhonePageFlow);

  const modalOverlayOpen = open && !usePhonePageFlow;
  const modalOverlayState = useMemo(
    () => ({
      ...overlayState,
      isOpen: modalOverlayOpen,
    }),
    [overlayState, modalOverlayOpen],
  );
  const { modalProps: desktopModalProps, underlayProps: desktopUnderlayProps } = useModalOverlay(
    {
      isDismissable: !usePhonePageFlow && Boolean(isDismissable),
      isKeyboardDismissDisabled,
      shouldCloseOnInteractOutside,
    },
    modalOverlayState,
    modalRef,
  );
  const { overlayProps: pageFlowOverlayProps, underlayProps: pageFlowUnderlayProps } = useOverlay(
    {
      isOpen: open && usePhonePageFlow,
      onClose: overlayState.close,
      isDismissable: false,
      isKeyboardDismissDisabled,
      shouldCloseOnInteractOutside,
    },
    modalRef,
  );
  const modalProps = usePhonePageFlow ? pageFlowOverlayProps : desktopModalProps;
  const underlayProps = usePhonePageFlow ? pageFlowUnderlayProps : desktopUnderlayProps;

  const pageModalContext = useMemo<PageModalContextValue>(
    () => ({
      modalRef,
      modalProps,
      isDismissable: !usePhonePageFlow && Boolean(isDismissable),
      pageFlow: usePhonePageFlow,
      isEnteredReady,
      isExiting,
      modalOnExitRef,
    }),
    [
      modalRef,
      modalProps,
      usePhonePageFlow,
      isDismissable,
      isEnteredReady,
      isExiting,
      modalOnExitRef,
    ],
  );

  useEffect(() => {
    if (!open || !usePhonePageFlow || !portalContainer) return;
    return acquireOutsideInert(portalContainer);
  }, [open, usePhonePageFlow, portalContainer]);

  useLayoutEffect(() => {
    if (!open || !usePhonePageFlow || typeof window === "undefined") return;
    const handoff = acquirePageFlowHandoff({
      root: document.getElementById("coforge-app-root"),
      win: window,
      layerEl: layerRef.current,
      manageInert: false,
    });
    entryIdRef.current = handoff.id;
    return () => {
      if (entryIdRef.current === handoff.id) {
        entryIdRef.current = null;
      }
      handoff.release();
    };
  }, [open, usePhonePageFlow, layerRef]);

  useEffect(() => {
    if (!open || !usePhonePageFlow || isKeyboardDismissDisabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Node && modalRef.current?.contains(event.target)) return;
      if (entryIdRef.current && !isTopPageFlowEntry(entryIdRef.current)) return;
      if (document.querySelector("[data-page-scrim]")) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, usePhonePageFlow, isKeyboardDismissDisabled, modalRef]);

  const overlayRenderState: ModalRenderState = {
    isEntering: isOverlayEntering,
    isExiting,
    state: overlayState,
  };
  const resolvedChildren = resolveRender(children, overlayRenderState, {
    defaultChildren: undefined,
  });
  const resolvedClass = resolveRender(className, overlayRenderState, {
    defaultClassName: undefined,
  });

  const overlayStyle: CSSProperties | undefined = usePhonePageFlow
    ? undefined
    : ({
        zIndex: OVERLAY_CONTENT_Z,
        "--visual-viewport-width": viewportSize.width > 0 ? `${viewportSize.width}px` : "100vw",
        "--visual-viewport-height": viewportSize.height > 0 ? `${viewportSize.height}px` : "100dvh",
        "--visual-viewport-top": `${viewportTop}px`,
        "--spacing-safe-bottom":
          "max(0px, calc(env(safe-area-inset-bottom, 0px) - (var(--app-height, 100dvh) - var(--visual-viewport-height, var(--app-height, 100dvh)))))",
      } as CSSProperties);

  const overlayClass = usePhonePageFlow
    ? `relative ${OVERLAY_LAYER} flex min-h-dvh w-full flex-col bg-primary safe-area-padding`
    : cx(
        "fixed inset-0 z-10 flex min-h-dvh w-full items-end justify-center px-4 outline-hidden sm:items-center sm:justify-center sm:px-8",
        "pt-(--modal-pt) pb-(--modal-pb) [--modal-pb:clamp(16px,8vh,64px)] [--modal-pt:16px] sm:[--modal-pb:32px] sm:[--modal-pt:32px]",
        isOverlayEntering && "motion-enter animate-in fade-in",
        isExiting && "motion-leave animate-out fade-out",
        instant ? "animate-none!" : [isOverlayEntering && "scrim-in", isExiting && "scrim-out"],
        "max-sm:top-(--visual-viewport-top) max-sm:bottom-auto max-sm:h-(--visual-viewport-height) max-sm:min-h-0",
        !keyboardMayBeUp &&
          "max-sm:[--visual-viewport-height:var(--app-height,100dvh)]! max-sm:[--visual-viewport-top:0px]!",
        "max-sm:items-stretch max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px]",
        resolvedClass,
        "max-sm:visible sm:invisible z-10 bg-transparent backdrop-blur-none",
      );

  return (
    <>
      {scrim.enabled && (
        <PageCoordinateScrim
          open={open && !usePhonePageFlow}
          portalContainer={portalContainer}
          zIndex={OVERLAY_SCRIM_Z}
          className={scrim.className}
        />
      )}
      <Overlay portalContainer={portalContainer} isExiting={isExiting} shouldContainFocus>
        <OverlayTriggerStateContext.Provider value={overlayState}>
          <ModalContext.Provider value={modalContext}>
            <PageModalContext.Provider value={pageModalContext}>
              <div
                {...underlayProps}
                ref={combinedOverlayRef}
                data-entering={isOverlayEntering || undefined}
                data-exiting={isExiting || undefined}
                data-phone-page-flow={usePhonePageFlow ? "" : undefined}
                style={overlayStyle}
                className={overlayClass}
              >
                {resolvedChildren}
              </div>
            </PageModalContext.Provider>
          </ModalContext.Provider>
        </OverlayTriggerStateContext.Provider>
      </Overlay>
    </>
  );
}

export function UnifiedPageModal({
  pageModal,
  instant,
  className,
  children,
  ...props
}: ComponentProps<typeof OfficialModal> & {
  pageModal: PageModalContextValue;
  instant: boolean;
}) {
  const triggerState = useContext(OverlayTriggerStateContext);
  const fallbackState = useOverlayTriggerState({ isOpen: true });
  const state = triggerState ?? fallbackState;
  const {
    isDismissable: _isDismissable,
    isKeyboardDismissDisabled: _isKeyboardDismissDisabled,
    isOpen: _isOpen,
    defaultOpen: _defaultOpen,
    onOpenChange: _onOpenChange,
    isEntering: propIsEntering,
    isExiting: propIsExiting,
    shouldCloseOnInteractOutside: _shouldCloseOnInteractOutside,
    UNSTABLE_portalContainer: _portalContainer,
    onEnter,
    onExit,
    style,
    ...domProps
  } = props;
  const isModalEntering =
    useOverlayEnterAnimation(pageModal.modalRef, pageModal.isEnteredReady, onEnter) ||
    Boolean(propIsEntering);
  const isModalExiting = pageModal.isExiting || Boolean(propIsExiting);

  useLayoutEffect(() => {
    pageModal.modalOnExitRef.current = onExit ?? null;
    return () => {
      if (pageModal.modalOnExitRef.current === onExit) {
        pageModal.modalOnExitRef.current = null;
      }
    };
  }, [pageModal.modalOnExitRef, onExit]);

  const modalRenderState: ModalRenderState = {
    isEntering: isModalEntering,
    isExiting: isModalExiting,
    state,
  };
  const resolvedClass = resolveRender(className, modalRenderState, {
    defaultClassName: undefined,
  });
  const resolvedChildren = resolveRender(children, modalRenderState, {
    defaultChildren: undefined,
  });
  const resolvedStyle = resolveRender(style, modalRenderState, {
    defaultStyle: {} as CSSProperties,
  });
  const modalClass = pageModal.pageFlow
    ? cx(
        "visible flex w-full flex-1 flex-col bg-primary",
        resolvedClass,
        "h-auto max-h-none w-full max-w-none overflow-visible rounded-none shadow-none ring-0",
      )
    : cx(
        "rounded-xl bg-primary align-middle shadow-xl outline-hidden max-sm:overflow-y-auto sm:rounded-2xl",
        "max-h-[calc(var(--visual-viewport-height)-var(--modal-pt)-var(--modal-pb))]",
        isModalEntering && "motion-enter animate-in zoom-in-95",
        isModalExiting && "motion-leave animate-out zoom-out-95",
        "visible rounded-4xl sm:rounded-4xl ring-1 ring-modal-edge",
        instant ? "animate-none!" : [isModalEntering && "sm:fade-in", isModalExiting && "fade-out"],
        resolvedClass,
        "max-sm:h-full max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:ring-0 max-sm:safe-area-padding",
      );

  return (
    <div
      {...mergeProps(domProps as HTMLAttributes<HTMLDivElement>, pageModal.modalProps)}
      ref={pageModal.modalRef}
      data-entering={isModalEntering || undefined}
      data-exiting={isModalExiting || undefined}
      style={resolvedStyle}
      className={modalClass}
    >
      {pageModal.isDismissable ? <DismissButton onDismiss={state.close} /> : null}
      {resolvedChildren}
    </div>
  );
}
