import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  LazyAgentProfilePanel,
  LazyPersonProfilePanel,
} from "#src/features/agents/profile-panel/lazy-profile-panels";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";

type Profile = { kind: "agent" | "person"; id: string; tab?: AgentProfileTab };

export type TaskPopupFocusSnapshot = {
  trigger: HTMLElement | null;
  fallback: HTMLElement | null;
};

function isFocusableTarget(target: HTMLElement | null): target is HTMLElement {
  return Boolean(target && target.isConnected && !target.closest("[inert]"));
}

export function resolveTaskDetailFocusFallback(
  activeElement: Element | null,
  doc?: Pick<Document, "querySelectorAll">,
): HTMLElement | null {
  if (activeElement instanceof HTMLElement) {
    const dialog = activeElement.closest<HTMLElement>('[role="dialog"]');
    if (dialog) return dialog;
    const panel = activeElement.closest<HTMLElement>("[data-task-detail]");
    if (panel) {
      return panel.querySelector<HTMLElement>("[data-task-detail-heading]") ?? panel;
    }
  }
  if (!doc) return null;
  const panels = doc.querySelectorAll<HTMLElement>("[data-task-detail]");
  const panel = panels.item(panels.length - 1);
  if (panel) {
    return panel.querySelector<HTMLElement>("[data-task-detail-heading]") ?? panel;
  }
  const sheets = doc.querySelectorAll<HTMLElement>('[data-detent-sheet] [role="dialog"]');
  return sheets.item(sheets.length - 1);
}

export function captureTaskPopupFocusTarget(
  activeElement: Element | null,
  doc?: Pick<Document, "body" | "documentElement" | "querySelectorAll">,
): TaskPopupFocusSnapshot {
  const trigger =
    activeElement instanceof HTMLElement &&
    activeElement !== doc?.body &&
    activeElement !== doc?.documentElement &&
    (activeElement.closest('[role="dialog"]') !== null ||
      activeElement.closest("[data-task-detail]") !== null)
      ? activeElement
      : null;
  return {
    trigger,
    fallback: resolveTaskDetailFocusFallback(activeElement, doc),
  };
}

export function resolveTaskPopupRestoreFocus(
  snapshot: TaskPopupFocusSnapshot | null,
  doc?: Pick<Document, "querySelectorAll">,
): HTMLElement | null {
  if (snapshot) {
    if (isFocusableTarget(snapshot.trigger)) return snapshot.trigger;
    if (isFocusableTarget(snapshot.fallback)) return snapshot.fallback;
  }
  const latestFallback = resolveTaskDetailFocusFallback(null, doc);
  return isFocusableTarget(latestFallback) ? latestFallback : null;
}

export function focusRestoredTarget(target: HTMLElement) {
  target.setAttribute("data-skip-focus-preview", "");
  try {
    target.focus({ preventScroll: true });
  } finally {
    target.removeAttribute("data-skip-focus-preview");
  }
}

export function useTaskPopupProfile(taskId: string | undefined): {
  openers: { onOpenAgentProfile: OpenAgentProfile; onOpenPersonProfile: OpenPersonProfile };
  open: boolean;
  close: () => void;
  panel: ReactNode;
} {
  const [opened, setOpened] = useState<Profile & { taskId: string }>();
  const profile = opened && opened.taskId === taskId ? opened : undefined;
  const isOpen = Boolean(profile);
  const returnFocusRef = useRef<TaskPopupFocusSnapshot | null>(null);
  const wasOpenRef = useRef(false);
  const prevTaskIdRef = useRef(taskId);
  const close = useCallback(() => setOpened(undefined), []);
  const open = useCallback(
    (next: Profile) => {
      if (!taskId) return;
      if (
        !wasOpenRef.current &&
        returnFocusRef.current === null &&
        typeof document !== "undefined"
      ) {
        returnFocusRef.current = captureTaskPopupFocusTarget(document.activeElement, document);
      }
      setOpened({ ...next, taskId });
    },
    [taskId],
  );
  useLayoutEffect(() => {
    if (prevTaskIdRef.current !== taskId) {
      prevTaskIdRef.current = taskId;
      returnFocusRef.current = null;
      wasOpenRef.current = isOpen;
      return;
    }
    if (wasOpenRef.current && !isOpen) {
      const snapshot = returnFocusRef.current;
      returnFocusRef.current = null;
      const target = resolveTaskPopupRestoreFocus(
        snapshot,
        typeof document !== "undefined" ? document : undefined,
      );
      if (target) focusRestoredTarget(target);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, taskId]);
  const onTabChange = useCallback((tab: AgentProfileTab) => {
    setOpened((current) => (current ? { ...current, tab } : current));
  }, []);
  const openers = useMemo(
    () => ({
      onOpenAgentProfile: (id: string, tab?: AgentProfileTab) => open({ kind: "agent", id, tab }),
      onOpenPersonProfile: (id: string) => open({ kind: "person", id }),
    }),
    [open],
  );
  const panel = profile ? (
    profile.kind === "agent" ? (
      <LazyAgentProfilePanel
        key={profile.id}
        agentId={profile.id}
        requestedTab={profile.tab}
        onTabChange={onTabChange}
        onClose={close}
      />
    ) : (
      <LazyPersonProfilePanel
        key={profile.id}
        userId={profile.id}
        onClose={close}
        onOpenAgent={(id) => open({ kind: "agent", id })}
      />
    )
  ) : null;
  return {
    openers,
    open: isOpen,
    close,
    panel,
  };
}
