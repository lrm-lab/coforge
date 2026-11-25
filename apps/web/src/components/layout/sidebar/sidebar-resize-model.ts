import {
  SIDEBAR_COLUMN,
  clampListWidth,
} from "#src/features/conversations/conversation-list-width";

export const SIDEBAR_RAIL_REM = 3.5;
export const SIDEBAR_COLLAPSE_THRESHOLD_REM = SIDEBAR_COLUMN.min;
export const SIDEBAR_EXPAND_THRESHOLD_REM = 7.25;
export const SIDEBAR_REEXPAND_HYSTERESIS_REM = SIDEBAR_COLLAPSE_THRESHOLD_REM + 0.75;
export const SIDEBAR_RECOLLAPSE_THRESHOLD_REM = 6;
export const SIDEBAR_NEAR_SNAP_REM = SIDEBAR_COLLAPSE_THRESHOLD_REM + 1;

const KEY_STEP_REM = 1;
const KEY_STEP_LARGE_REM = 4;
const CURSOR_CATCHUP_TOLERANCE_REM = 0.5;

export type SidebarDragState = {
  startedCollapsed: boolean;
  collapsed: boolean;
  awaitingCursorCatchup: boolean;
  startWidth: number;
  startX: number;
  width: number;
  rememberedWidth: number;
  rtl: boolean;
  resizedWhileExpanded: boolean;
};

export type SidebarDragStep = {
  state: SidebarDragState;
  collapsed: boolean;
  collapsedChanged: boolean;
  width: number;
  snapPrimed: boolean;
  liveResize: boolean;
};

export type SidebarDragFinish = {
  collapsed: boolean;
  commitWidth: number | undefined;
  restoreWidth: number | undefined;
};

type KeyboardLike = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

export type SidebarKeyResult = { collapsed: true } | { collapsed: false; width: number };

export function beginSidebarDrag({
  collapsed,
  currentWidth,
  rememberedWidth,
  startX,
  rtl,
}: {
  collapsed: boolean;
  currentWidth: number;
  rememberedWidth: number;
  startX: number;
  rtl: boolean;
}): SidebarDragState {
  const safeRemembered = clampListWidth(SIDEBAR_COLUMN, rememberedWidth);
  return {
    startedCollapsed: collapsed,
    collapsed,
    awaitingCursorCatchup: false,
    startWidth: collapsed ? SIDEBAR_RAIL_REM : currentWidth,
    startX,
    width: collapsed ? SIDEBAR_RAIL_REM : currentWidth,
    rememberedWidth: safeRemembered,
    rtl,
    resizedWhileExpanded: false,
  };
}

export function stepSidebarDrag(state: SidebarDragState, x: number): SidebarDragStep {
  const direction = state.rtl ? -1 : 1;
  const rawWidth = state.startWidth + (x - state.startX) * direction;
  const expandAt = state.startedCollapsed
    ? SIDEBAR_EXPAND_THRESHOLD_REM
    : SIDEBAR_REEXPAND_HYSTERESIS_REM;

  if (!state.collapsed) {
    if (state.awaitingCursorCatchup) {
      if (rawWidth >= state.rememberedWidth - CURSOR_CATCHUP_TOLERANCE_REM) {
        const nextWidth = clampListWidth(SIDEBAR_COLUMN, rawWidth);
        const nextState: SidebarDragState = {
          ...state,
          awaitingCursorCatchup: false,
          width: nextWidth,
          resizedWhileExpanded: true,
        };
        return {
          state: nextState,
          collapsed: false,
          collapsedChanged: false,
          width: nextWidth,
          snapPrimed: false,
          liveResize: true,
        };
      }
      if (rawWidth < SIDEBAR_RECOLLAPSE_THRESHOLD_REM) {
        const nextState: SidebarDragState = {
          ...state,
          collapsed: true,
          awaitingCursorCatchup: false,
          width: SIDEBAR_RAIL_REM,
        };
        return {
          state: nextState,
          collapsed: true,
          collapsedChanged: true,
          width: SIDEBAR_RAIL_REM,
          snapPrimed: false,
          liveResize: false,
        };
      }
      return {
        state,
        collapsed: false,
        collapsedChanged: false,
        width: state.width,
        snapPrimed: false,
        liveResize: false,
      };
    }

    if (rawWidth < SIDEBAR_COLLAPSE_THRESHOLD_REM) {
      const nextState: SidebarDragState = {
        ...state,
        collapsed: true,
        width: SIDEBAR_RAIL_REM,
      };
      return {
        state: nextState,
        collapsed: true,
        collapsedChanged: true,
        width: SIDEBAR_RAIL_REM,
        snapPrimed: false,
        liveResize: false,
      };
    }

    const nextWidth = clampListWidth(SIDEBAR_COLUMN, rawWidth);
    const nextState: SidebarDragState = {
      ...state,
      width: nextWidth,
      resizedWhileExpanded: true,
    };
    return {
      state: nextState,
      collapsed: false,
      collapsedChanged: false,
      width: nextWidth,
      snapPrimed: nextWidth < SIDEBAR_NEAR_SNAP_REM,
      liveResize: true,
    };
  }

  if (rawWidth > expandAt) {
    const nextWidth = state.startedCollapsed
      ? state.rememberedWidth
      : clampListWidth(SIDEBAR_COLUMN, rawWidth);
    const nextState: SidebarDragState = {
      ...state,
      collapsed: false,
      awaitingCursorCatchup: state.startedCollapsed,
      width: nextWidth,
      resizedWhileExpanded: !state.startedCollapsed,
    };
    return {
      state: nextState,
      collapsed: false,
      collapsedChanged: true,
      width: nextWidth,
      snapPrimed: false,
      liveResize: false,
    };
  }

  return {
    state,
    collapsed: true,
    collapsedChanged: false,
    width: SIDEBAR_RAIL_REM,
    snapPrimed: false,
    liveResize: false,
  };
}

export function finishSidebarDrag(state: SidebarDragState): SidebarDragFinish {
  if (state.collapsed) {
    return {
      collapsed: true,
      commitWidth: undefined,
      restoreWidth: state.resizedWhileExpanded ? state.rememberedWidth : undefined,
    };
  }
  if (state.resizedWhileExpanded) {
    return {
      collapsed: false,
      commitWidth: clampListWidth(SIDEBAR_COLUMN, state.width),
      restoreWidth: undefined,
    };
  }
  return {
    collapsed: false,
    commitWidth: undefined,
    restoreWidth: undefined,
  };
}

export function keySidebarResize(
  event: KeyboardLike,
  {
    collapsed,
    width,
    rememberedWidth,
    rtl = false,
  }: {
    collapsed: boolean;
    width: number;
    rememberedWidth: number;
    rtl?: boolean;
  },
): SidebarKeyResult | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const step = event.shiftKey ? KEY_STEP_LARGE_REM : KEY_STEP_REM;
  const toward = rtl ? -1 : 1;
  const safeRemembered = clampListWidth(SIDEBAR_COLUMN, rememberedWidth);

  switch (event.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      const delta = (event.key === "ArrowRight" ? step : -step) * toward;
      if (collapsed) {
        if (delta <= 0) return undefined;
        return { collapsed: false, width: safeRemembered };
      }
      const next = width + delta;
      if (next < SIDEBAR_COLLAPSE_THRESHOLD_REM) return { collapsed: true };
      return { collapsed: false, width: clampListWidth(SIDEBAR_COLUMN, next) };
    }
    case "Home":
      return collapsed ? undefined : { collapsed: true };
    case "End":
      return { collapsed: false, width: SIDEBAR_COLUMN.max };
    default:
      return undefined;
  }
}
