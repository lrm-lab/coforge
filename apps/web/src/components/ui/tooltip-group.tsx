import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  createLabelGroupController,
  LABEL_COOLDOWN_MS,
  LABEL_OPEN_DELAY_MS,
  type LabelGroupController,
  type LabelGroupSnapshot,
} from "#src/lib/hover-intent";

export interface TooltipGroupContextValue {
  readonly activeId: string | null;
  readonly instant: boolean;
  readonly openDelayMs: number;
  readonly isKeyboardModality: () => boolean;
  readonly onTriggerOpenRequest: (id: string, fromKeyboard: boolean) => void;
  readonly onTriggerCloseRequest: (id: string, fromBlur: boolean) => void;
  readonly onTriggerPress: (id: string) => void;
}

const TooltipGroupContext = createContext<TooltipGroupContextValue | null>(null);

export function useTooltipGroup(): TooltipGroupContextValue | null {
  return useContext(TooltipGroupContext);
}

export function TooltipGroup({
  children,
  className,
  openDelayMs = LABEL_OPEN_DELAY_MS,
  cooldownMs = LABEL_COOLDOWN_MS,
}: {
  children: ReactNode;
  className?: string;
  openDelayMs?: number;
  cooldownMs?: number;
}) {
  const [snapshot, setSnapshot] = useState<LabelGroupSnapshot>({
    activeId: null,
    instant: false,
  });
  const keyboardModalityRef = useRef(false);
  const controllerRef = useRef<LabelGroupController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = createLabelGroupController({
      openDelayMs,
      cooldownMs,
      onChange: setSnapshot,
    });
  }

  useEffect(() => {
    const controller = createLabelGroupController({
      openDelayMs,
      cooldownMs,
      onChange: setSnapshot,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [cooldownMs, openDelayMs]);

  const isKeyboardModality = useCallback(() => keyboardModalityRef.current, []);

  const onTriggerOpenRequest = useCallback((id: string, fromKeyboard: boolean) => {
    if (fromKeyboard) {
      controllerRef.current?.focusTrigger(id);
      return;
    }
    controllerRef.current?.pointerEnterTrigger(id);
  }, []);

  const onTriggerCloseRequest = useCallback((id: string, fromBlur: boolean) => {
    if (fromBlur) {
      controllerRef.current?.blurTrigger(id);
      return;
    }
    controllerRef.current?.pointerLeaveTrigger(id);
  }, []);

  const onTriggerPress = useCallback((id: string) => {
    controllerRef.current?.pressTrigger(id);
  }, []);

  const handlePointerMoveCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      keyboardModalityRef.current = false;
    }
  }, []);

  const handlePointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    keyboardModalityRef.current = false;
    const activeId = controllerRef.current?.getSnapshot().activeId;
    if (activeId) {
      controllerRef.current?.pressTrigger(activeId);
    }
  }, []);

  const handlePointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    controllerRef.current?.pointerLeaveGroup();
  }, []);

  const handleKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      controllerRef.current?.escape();
      return;
    }
    keyboardModalityRef.current = true;
  }, []);

  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    const activeId = controllerRef.current?.getSnapshot().activeId;
    if (activeId) {
      controllerRef.current?.blurTrigger(activeId);
    }
  }, []);

  const value = useMemo<TooltipGroupContextValue>(
    () => ({
      activeId: snapshot.activeId,
      instant: snapshot.instant,
      openDelayMs,
      isKeyboardModality,
      onTriggerOpenRequest,
      onTriggerCloseRequest,
      onTriggerPress,
    }),
    [
      isKeyboardModality,
      onTriggerCloseRequest,
      onTriggerOpenRequest,
      onTriggerPress,
      openDelayMs,
      snapshot.activeId,
      snapshot.instant,
    ],
  );

  return (
    <TooltipGroupContext.Provider value={value}>
      <div
        className={className}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerLeave={handlePointerLeave}
        onKeyDownCapture={handleKeyDownCapture}
        onBlurCapture={handleBlurCapture}
      >
        {children}
      </div>
    </TooltipGroupContext.Provider>
  );
}
