import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";

import { CHAT_SECTIONS } from "./tab-home";

export const SUBPAGE_VIEW_TRANSITION_TYPES = {
  push: "subpage-push",
  pop: "subpage-pop",
} as const;

export type SubpageTransitionDirection = keyof typeof SUBPAGE_VIEW_TRANSITION_TYPES;

const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)";
const TAB_HOME_SECTIONS = new Set(["", "activity", "workspace", "me"]);
const RECORDS_PEER_TABS = new Set(["dashboard", "stats", "settings"]);

export function subpageDepth(rest: string): number {
  const path = rest.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  const first = segments[0] ?? "";
  if (TAB_HOME_SECTIONS.has(first)) return 0;
  if (first === "computer" || first === "agent") return 2;
  if (first === "projects") return Math.min(segments.length, 3);
  if (first === "artifacts" || first === "memory") return Math.min(segments.length, 2);
  if (first === "records") {
    if (segments.length <= 1) return 1;
    if (segments.length === 2 && RECORDS_PEER_TABS.has(segments[1]!)) return 1;
    return 2;
  }
  return Math.max(1, segments.length);
}

export function subpageTransitionDirection(
  fromPathname: string,
  toPathname: string,
): SubpageTransitionDirection | null {
  const from = splitWorkspacePath(fromPathname);
  const to = splitWorkspacePath(toPathname);
  if (!from || !to || from.slug !== to.slug) return null;
  const fromSection = (from.rest.split(/[?#]/, 1)[0] ?? "").split("/")[1] ?? "";
  const toSection = (to.rest.split(/[?#]/, 1)[0] ?? "").split("/")[1] ?? "";
  if (CHAT_SECTIONS.includes(fromSection) && CHAT_SECTIONS.includes(toSection)) return null;
  const fromDepth = subpageDepth(from.rest);
  const toDepth = subpageDepth(to.rest);
  if (toDepth > fromDepth) return "push";
  if (toDepth < fromDepth) return "pop";
  return null;
}

type TransitionLocationChange = {
  fromLocation?: { pathname: string };
  toLocation: { pathname: string };
  pathChanged: boolean;
};

type TransitionEnvironment = {
  isDesktop?: boolean;
  supportsViewTransitionTypes?: boolean;
  hasUAVisualTransition?: boolean;
};

type VisualTransitionEvent = Event & { hasUAVisualTransition?: boolean };

type NavigationEventTarget = {
  addEventListener: (type: "navigate", listener: (event: VisualTransitionEvent) => void) => void;
};

let uaVisualTransitionDetected = false;
let uaTrackerInstalled = false;

export function installUAVisualTransitionTracker(): void {
  if (uaTrackerInstalled || typeof window === "undefined") return;
  uaTrackerInstalled = true;
  const record = (event: VisualTransitionEvent) => {
    uaVisualTransitionDetected = Boolean(event.hasUAVisualTransition);
  };
  const nav = (window as Window & { navigation?: NavigationEventTarget }).navigation;
  nav?.addEventListener("navigate", record);
  window.addEventListener("popstate", record, { capture: true });
}

function consumeUAVisualTransition(): boolean {
  const detected = uaVisualTransitionDetected;
  uaVisualTransitionDetected = false;
  return detected;
}

function defaultIsDesktop(): boolean {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia(DESKTOP_MEDIA_QUERY).matches
  );
}

function defaultSupportsViewTransitionTypes(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.CSS?.supports === "function" &&
    window.CSS.supports("selector(:active-view-transition-type(a))")
  );
}

export function resolveSubpageViewTransitionTypes(
  change: TransitionLocationChange,
  env?: TransitionEnvironment,
): string[] | false {
  const uaHandled = env?.hasUAVisualTransition ?? consumeUAVisualTransition();
  if (uaHandled || !change.pathChanged || !change.fromLocation) return false;
  const isDesktop = env?.isDesktop ?? defaultIsDesktop();
  if (isDesktop) return false;
  const supported = env?.supportsViewTransitionTypes ?? defaultSupportsViewTransitionTypes();
  if (!supported) return false;
  const direction = subpageTransitionDirection(
    change.fromLocation.pathname,
    change.toLocation.pathname,
  );
  return direction ? [SUBPAGE_VIEW_TRANSITION_TYPES[direction]] : false;
}
