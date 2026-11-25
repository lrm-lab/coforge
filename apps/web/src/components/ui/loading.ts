import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export const BUTTON_LOADING_SHOW_DELAY_MS = 150;
export const BUTTON_LOADING_MIN_VISIBLE_MS = 400;
export const BUTTON_LOADING_EXIT_DURATION_MS = 200;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type ButtonLoadingPhase = "idle" | "delaying" | "visible" | "holding" | "exiting";
export type ButtonLoadingTimerKind = "show" | "hold-end" | "exit-end";

export interface ButtonLoadingSnapshot<TContent> {
  content: TContent;
  intent: unknown;
}

export interface ButtonLoadingState<TContent> {
  phase: ButtonLoadingPhase;
  enteredAt: number;
  shownAt: number;
  exitedAt: number;
  lockedWidth: number | null;
  frozenSnapshot: ButtonLoadingSnapshot<TContent> | null;
}

export interface ButtonLoadingTimer {
  kind: ButtonLoadingTimerKind;
  delayMs: number;
}

export interface ButtonLoadingTransition<TContent> {
  state: ButtonLoadingState<TContent>;
  nextTimer: ButtonLoadingTimer | null;
}

export interface ButtonLoadingSyncInput<TContent> {
  loading: boolean;
  now: number;
  currentSnapshot: ButtonLoadingSnapshot<TContent>;
  idleSnapshot: ButtonLoadingSnapshot<TContent> | null;
  idleWidth: number | null;
}

export interface ButtonLoadingPresentation<TContent> {
  showIndicator: boolean;
  loadingActive: boolean;
  lockedWidth: number | null;
  frozenContent: TContent | null;
}

export function createButtonLoadingState<TContent>(): ButtonLoadingState<TContent> {
  return {
    phase: "idle",
    enteredAt: 0,
    shownAt: 0,
    exitedAt: 0,
    lockedWidth: null,
    frozenSnapshot: null,
  };
}

export function areButtonLoadingValuesEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (
    depth > 8 ||
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!areButtonLoadingValuesEqual(left[index], right[index], depth + 1)) {
        return false;
      }
    }
    return true;
  }
  if (isValidElement(left) || isValidElement(right)) {
    if (!isValidElement(left) || !isValidElement(right)) {
      return false;
    }
    if (left.type !== right.type || left.key !== right.key) {
      return false;
    }
    return areButtonLoadingValuesEqual(left.props, right.props, depth + 1);
  }
  const leftProto = Object.getPrototypeOf(left);
  const rightProto = Object.getPrototypeOf(right);
  const isPlain =
    (leftProto === Object.prototype || leftProto === null) &&
    (rightProto === Object.prototype || rightProto === null);
  if (!isPlain) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)) return false;
    if (!areButtonLoadingValuesEqual(leftRecord[key], rightRecord[key], depth + 1)) {
      return false;
    }
  }
  return true;
}

function hasButtonSnapshotChanged<TContent>(
  frozenSnapshot: ButtonLoadingSnapshot<TContent> | null,
  currentSnapshot: ButtonLoadingSnapshot<TContent>,
): boolean {
  return frozenSnapshot !== null && !areButtonLoadingValuesEqual(frozenSnapshot, currentSnapshot);
}

export function resolveButtonLoadingPresentation<TContent>(
  state: ButtonLoadingState<TContent>,
  loading: boolean,
  currentSnapshot: ButtonLoadingSnapshot<TContent>,
): ButtonLoadingPresentation<TContent> {
  if (
    !loading &&
    (state.phase === "idle" ||
      state.phase === "delaying" ||
      hasButtonSnapshotChanged(state.frozenSnapshot, currentSnapshot))
  ) {
    return {
      showIndicator: false,
      loadingActive: false,
      lockedWidth: null,
      frozenContent: null,
    };
  }

  return {
    showIndicator: state.phase === "visible" || state.phase === "holding",
    loadingActive: loading || state.phase !== "idle",
    lockedWidth: state.lockedWidth,
    frozenContent: state.frozenSnapshot ? state.frozenSnapshot.content : null,
  };
}

export function syncButtonLoadingState<TContent>(
  state: ButtonLoadingState<TContent>,
  input: ButtonLoadingSyncInput<TContent>,
): ButtonLoadingTransition<TContent> {
  if (input.loading) {
    const lockedWidth = state.lockedWidth ?? input.idleWidth;
    const frozenSnapshot = state.frozenSnapshot ?? input.idleSnapshot ?? input.currentSnapshot;
    if (state.phase === "idle" || state.phase === "exiting") {
      return {
        state: {
          phase: "delaying",
          enteredAt: input.now,
          shownAt: 0,
          exitedAt: 0,
          lockedWidth,
          frozenSnapshot,
        },
        nextTimer: { kind: "show", delayMs: BUTTON_LOADING_SHOW_DELAY_MS },
      };
    }
    if (state.phase === "delaying") {
      const nextState =
        lockedWidth === state.lockedWidth && frozenSnapshot === state.frozenSnapshot
          ? state
          : { ...state, lockedWidth, frozenSnapshot };
      return {
        state: nextState,
        nextTimer: {
          kind: "show",
          delayMs: Math.max(0, BUTTON_LOADING_SHOW_DELAY_MS - (input.now - state.enteredAt)),
        },
      };
    }
    const nextState =
      state.phase === "visible" &&
      lockedWidth === state.lockedWidth &&
      frozenSnapshot === state.frozenSnapshot
        ? state
        : { ...state, phase: "visible" as const, lockedWidth, frozenSnapshot };
    return { state: nextState, nextTimer: null };
  }

  if (state.phase === "idle") {
    return { state, nextTimer: null };
  }

  if (
    state.phase === "delaying" ||
    hasButtonSnapshotChanged(state.frozenSnapshot, input.currentSnapshot)
  ) {
    return { state: createButtonLoadingState<TContent>(), nextTimer: null };
  }

  if (state.phase === "visible" || state.phase === "holding") {
    const remaining = BUTTON_LOADING_MIN_VISIBLE_MS - (input.now - state.shownAt);
    if (remaining > 0) {
      return {
        state: state.phase === "holding" ? state : { ...state, phase: "holding" },
        nextTimer: { kind: "hold-end", delayMs: remaining },
      };
    }
    return {
      state: { ...state, phase: "exiting", exitedAt: input.now },
      nextTimer: { kind: "exit-end", delayMs: BUTTON_LOADING_EXIT_DURATION_MS },
    };
  }

  const remaining = BUTTON_LOADING_EXIT_DURATION_MS - (input.now - state.exitedAt);
  if (remaining > 0) {
    return { state, nextTimer: { kind: "exit-end", delayMs: remaining } };
  }
  return { state: createButtonLoadingState<TContent>(), nextTimer: null };
}

export function stepButtonLoadingTimer<TContent>(
  state: ButtonLoadingState<TContent>,
  timer: ButtonLoadingTimerKind,
  now: number,
): ButtonLoadingTransition<TContent> {
  if (timer === "show" && state.phase === "delaying") {
    return {
      state: { ...state, phase: "visible", shownAt: now },
      nextTimer: null,
    };
  }
  if (timer === "hold-end" && state.phase === "holding") {
    return {
      state: { ...state, phase: "exiting", exitedAt: now },
      nextTimer: { kind: "exit-end", delayMs: BUTTON_LOADING_EXIT_DURATION_MS },
    };
  }
  if (timer === "exit-end" && state.phase === "exiting") {
    return {
      state: createButtonLoadingState<TContent>(),
      nextTimer: null,
    };
  }
  return { state, nextTimer: null };
}

export function useLoadingVisible(active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);

    if (active) {
      showTimer.current = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, BUTTON_LOADING_SHOW_DELAY_MS);

      return () => clearTimeout(showTimer.current);
    }

    if (shownAt.current === 0) {
      setVisible(false);
      return;
    }

    const remaining = BUTTON_LOADING_MIN_VISIBLE_MS - (Date.now() - shownAt.current);
    shownAt.current = 0;

    if (remaining <= 0) {
      setVisible(false);
      return;
    }

    hideTimer.current = setTimeout(() => setVisible(false), remaining);

    return () => clearTimeout(hideTimer.current);
  }, [active]);

  return visible;
}

export function useButtonLoadingTransition<TContent>(
  loadingProp: boolean | undefined,
  elementRef: RefObject<HTMLElement | null>,
  content: TContent,
  measureDeps: readonly unknown[],
  intent?: unknown,
) {
  const canLoad = loadingProp !== undefined;
  const loading = Boolean(loadingProp);
  const [state, setState] = useState<ButtonLoadingState<TContent>>(() =>
    createButtonLoadingState(),
  );
  const stateRef = useRef(state);
  const idleWidthRef = useRef<number | null>(null);
  const idleSnapshotRef = useRef<ButtonLoadingSnapshot<TContent> | null>(null);
  const currentSnapshotRef = useRef<ButtonLoadingSnapshot<TContent>>({ content, intent });
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const currentSnapshot: ButtonLoadingSnapshot<TContent> = { content, intent };
  const presentation = canLoad
    ? resolveButtonLoadingPresentation(state, loading, currentSnapshot)
    : {
        showIndicator: false,
        loadingActive: false,
        lockedWidth: null,
        frozenContent: null,
      };
  const dismissedByChange =
    canLoad &&
    !loading &&
    state.phase !== "idle" &&
    hasButtonSnapshotChanged(state.frozenSnapshot, currentSnapshot);

  const scheduleTimer = useCallback((nextTimer: ButtonLoadingTimer | null) => {
    function arm(timer: ButtonLoadingTimer | null) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      if (!timer) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        const stepped = stepButtonLoadingTimer(stateRef.current, timer.kind, Date.now());
        if (stepped.state !== stateRef.current) {
          stateRef.current = stepped.state;
          setState(stepped.state);
        }
        arm(stepped.nextTimer);
      }, timer.delayMs);
    }
    arm(nextTimer);
  }, []);

  const captureIdleWidth = useCallback(() => {
    if (!canLoad || loading || stateRef.current.phase !== "idle") return;
    const width = elementRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0) idleWidthRef.current = width;
  }, [canLoad, loading, elementRef]);

  useIsomorphicLayoutEffect(() => {
    if (!canLoad) return;
    currentSnapshotRef.current = { content, intent };
  });

  useIsomorphicLayoutEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;

    if (!canLoad) {
      if (stateRef.current.phase !== "idle") {
        const reset = createButtonLoadingState<TContent>();
        stateRef.current = reset;
        setState(reset);
      }
      return;
    }

    const next = syncButtonLoadingState(stateRef.current, {
      loading,
      now: Date.now(),
      currentSnapshot: currentSnapshotRef.current,
      idleSnapshot: idleSnapshotRef.current,
      idleWidth: idleWidthRef.current,
    });
    if (next.state !== stateRef.current) {
      stateRef.current = next.state;
      setState(next.state);
    }
    scheduleTimer(next.nextTimer);

    return () => {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [canLoad, loading, dismissedByChange, scheduleTimer]);

  useIsomorphicLayoutEffect(() => {
    if (!canLoad || loading || state.phase !== "idle") return;
    idleSnapshotRef.current = { content, intent };
    const width = elementRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0) idleWidthRef.current = width;
  }, [canLoad, loading, state.phase, elementRef, ...measureDeps]);

  return {
    ...presentation,
    captureIdleWidth,
  };
}
