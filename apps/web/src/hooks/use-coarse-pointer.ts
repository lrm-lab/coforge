import { useAssumedPhone } from "./assumed-viewport";
import { useMediaQuery } from "./use-media-query";

/**
 * A touch pointer. Not `(hover: none)`: a browser with no pointer at all matches that too (a
 * headless Chromium on Linux reports `hover: none` and `pointer: none`), and a machine with nothing
 * to touch is not a touch device. CI's browser took the touch paths through it: Esc in a question
 * card only blurred, and rows changed to their touch layout after hydration (task
 * #coforge-designer-team:#125).
 */
const QUERY = "(any-pointer: coarse)";

/**
 * True on touch devices: any coarse pointer. The JS counterpart of `[@media(any-pointer:coarse)]`
 * in CSS, for behavior styles cannot express. The server render (and the hydrating one) assume a
 * mouse, or touch for a phone's request (`AssumedViewportProvider`), so a device that differs
 * renders again after hydration.
 */
export const useCoarsePointer = () => useMediaQuery(QUERY, useAssumedPhone());
