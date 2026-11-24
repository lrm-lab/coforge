import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";

import { m } from "#src/paraglide/messages";

import { NoticeCardHost } from "./notice-card";
import {
  ACTION_TOAST_MS,
  RESULT_TOAST_MS,
  UNDONE_TOAST_MS,
  createToastStore,
  statusToastMs,
  type ToastAction,
  type ToastIcon,
} from "./toast-model";
import { ToastView } from "./toast-view";

const toastStore = createToastStore();

function ToastHost() {
  const toast = useSyncExternalStore(toastStore.subscribe, toastStore.current, () => null);
  const regionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = regionRef.current?.querySelector<HTMLElement>("button") ?? null;
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    /* Safari 26+ freezes status-bar sampling over transparent fixed layers; hide the host with visibility: hidden and reveal only its visible children. */
    <section
      ref={regionRef}
      aria-label={m.toast_region()}
      className="pointer-events-none invisible fixed inset-x-0 top-[calc(var(--spacing-safe-top)+3.75rem)] z-60 grid justify-items-center px-4"
    >
      <p role="status" className="sr-only visible">
        {toast?.title}
      </p>
      <AnimatePresence>
        {toast ? (
          <ToastView key={toast.id} toast={toast} onDismiss={() => toastStore.dismiss(toast.id)} />
        ) : null}
      </AnimatePresence>
    </section>
  );
}

export function AppToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToastHost />
      <NoticeCardHost />
    </>
  );
}

function toastId(kind: string, title: string, key?: string) {
  return key === undefined ? `${kind}:${title}` : `${kind}:${title}:${key}`;
}

function closing(id: string, action: ToastAction): ToastAction {
  return {
    label: action.label,
    onClick: () => {
      toastStore.dismiss(id);
      action.onClick();
    },
  };
}

function show(
  id: string,
  title: string,
  icon: ToastIcon,
  durationMs = statusToastMs(title),
  action?: ToastAction,
) {
  toastStore.show({ id, title, icon, durationMs, action: action && closing(id, action) });
}

export const appToast = {
  success(title: string, options?: { action?: ToastAction; durationMs?: number; key?: string }) {
    show(
      toastId("success", title, options?.key),
      title,
      "done",
      options?.durationMs ?? (options?.action ? ACTION_TOAST_MS : statusToastMs(title)),
      options?.action,
    );
  },
  undoable(
    title: string,
    options: {
      onUndo: () => unknown;
      failed?: string | ((cause: unknown) => string);
      durationMs?: number;
      key?: string;
    },
  ) {
    const id = toastId("success", title, options.key);
    const undo = async () => {
      show(id, title, "progress", Infinity);
      try {
        await options.onUndo();
        show(id, m.toast_undone(), "done", UNDONE_TOAST_MS);
      } catch (cause) {
        const failed =
          typeof options.failed === "function"
            ? options.failed(cause)
            : (options.failed ?? m.toast_undo_failed());
        show(id, failed, "error");
      }
    };
    toastStore.show({
      id,
      title,
      icon: "countdown",
      durationMs: options.durationMs ?? ACTION_TOAST_MS,
      action: { label: m.action_undo(), onClick: () => void undo() },
    });
  },
  progress(title: string, options?: { key?: string }) {
    const id = options?.key === undefined ? toastId("progress", title) : `progress:${options.key}`;
    show(id, title, "progress", Infinity);
    return {
      update: (nextTitle: string) => show(id, nextTitle, "progress", Infinity),
      done: (result: string) => show(id, result, "done", RESULT_TOAST_MS),
      fail: (result: string) => show(id, result, "error"),
      dismiss: () => toastStore.dismiss(id),
    };
  },
  dismiss(title: string, key?: string) {
    toastStore.dismiss(toastId("success", title, key));
  },
  notice(title: string) {
    show(toastId("notice", title), title, "notice");
  },
  dismissShown(title: string) {
    toastStore.dismiss(toastId("notice", title));
    toastStore.dismiss(toastId("error", title));
  },
  error(title: string) {
    show(toastId("error", title), title, "error");
  },
};

export function useAppToast() {
  return appToast;
}
