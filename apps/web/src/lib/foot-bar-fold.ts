export const FOOT_BAR_FOLD_THRESHOLD_PX = 8;
export const FOOT_BAR_OPEN_THRESHOLD_PX = 8;
export const FOOT_BAR_TOP_OPEN_PX = 48;
export const FOOT_BAR_HOLD_MS = 320;

export type FootBarFoldState = {
  folded: boolean;
  lastScrollTop: number | null;
  downAccum: number;
  upAccum: number;
  lastTransitionAt: number;
  pendingFolded: boolean | null;
  focused: boolean;
};

export type ScrollSample = {
  scrollTop: number;
  maxScrollTop: number;
  viewportHeight: number;
  now: number;
};

export function createFootBarFoldState(): FootBarFoldState {
  return {
    folded: false,
    lastScrollTop: null,
    downAccum: 0,
    upAccum: 0,
    lastTransitionAt: -Infinity,
    pendingFolded: null,
    focused: false,
  };
}

function requestFold(state: FootBarFoldState, target: boolean, now: number): FootBarFoldState {
  if (state.focused && target) {
    return { ...state, folded: false, pendingFolded: null };
  }
  if (now - state.lastTransitionAt < FOOT_BAR_HOLD_MS) {
    return {
      ...state,
      pendingFolded: target === state.folded ? null : target,
    };
  }
  if (target === state.folded) {
    return state.pendingFolded === null ? state : { ...state, pendingFolded: null };
  }
  return {
    ...state,
    folded: target,
    lastTransitionAt: now,
    pendingFolded: null,
    downAccum: 0,
    upAccum: 0,
  };
}

export function stepFootBarScroll(state: FootBarFoldState, sample: ScrollSample): FootBarFoldState {
  const { scrollTop, maxScrollTop, viewportHeight, now } = sample;
  if (maxScrollTop <= 0 || scrollTop < 0 || scrollTop > maxScrollTop + 1) {
    return state;
  }

  if (state.lastScrollTop === null) {
    const next = { ...state, lastScrollTop: scrollTop };
    return scrollTop <= FOOT_BAR_TOP_OPEN_PX ? requestFold(next, false, now) : next;
  }

  const delta = scrollTop - state.lastScrollTop;
  if (viewportHeight > 0 && Math.abs(delta) > viewportHeight) {
    return {
      ...state,
      lastScrollTop: scrollTop,
      downAccum: 0,
      upAccum: 0,
    };
  }

  if (scrollTop <= FOOT_BAR_TOP_OPEN_PX) {
    const base = { ...state, lastScrollTop: scrollTop, downAccum: 0, upAccum: 0 };
    return requestFold(base, false, now);
  }

  if (delta > 0) {
    const downAccum = state.downAccum + delta;
    const base = { ...state, lastScrollTop: scrollTop, downAccum, upAccum: 0 };
    return downAccum >= FOOT_BAR_FOLD_THRESHOLD_PX ? requestFold(base, true, now) : base;
  }

  if (delta < 0) {
    const upAccum = state.upAccum - delta;
    const base = { ...state, lastScrollTop: scrollTop, downAccum: 0, upAccum };
    return upAccum >= FOOT_BAR_OPEN_THRESHOLD_PX ? requestFold(base, false, now) : base;
  }

  return state;
}

export function flushFootBarPending(state: FootBarFoldState, now: number): FootBarFoldState {
  if (state.pendingFolded === null) return state;
  if (now - state.lastTransitionAt < FOOT_BAR_HOLD_MS) return state;
  return requestFold(state, state.pendingFolded, now);
}

export function openFootBarNow(state: FootBarFoldState, now: number): FootBarFoldState {
  return {
    ...state,
    folded: false,
    lastTransitionAt: state.folded ? now : state.lastTransitionAt,
    pendingFolded: null,
    downAccum: 0,
    upAccum: 0,
  };
}

export function setFootBarFocus(
  state: FootBarFoldState,
  focused: boolean,
  now: number,
): FootBarFoldState {
  if (focused) {
    return {
      ...openFootBarNow(state, now),
      focused: true,
    };
  }
  return {
    ...state,
    focused: false,
  };
}

export function resetFootBarScroll(state: FootBarFoldState): FootBarFoldState {
  return {
    ...state,
    folded: false,
    lastScrollTop: null,
    downAccum: 0,
    upAccum: 0,
    pendingFolded: null,
  };
}
