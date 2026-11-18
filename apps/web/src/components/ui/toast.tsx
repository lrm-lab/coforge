import { type CSSProperties } from "react";
import { AlertCircle, CheckCircle } from "@untitledui/icons";
import { Toaster, toast } from "sonner";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";

const toastStyle: CSSProperties & Record<`--${string}`, string> = {
  "--normal-bg": "var(--color-bg-primary)",
  "--normal-text": "var(--color-text-primary)",
  "--normal-border": "var(--color-border-secondary)",
};

const offset = {
  top: "max(1rem, var(--spacing-safe-top))",
  bottom: "max(1rem, var(--spacing-safe-bottom))",
  right: "max(1rem, var(--spacing-safe-right))",
  left: "max(1rem, var(--spacing-safe-left))",
};

/** The toasts sit at the bottom and start above a one-line composer, so the moment after an action
 * leaves the composer free to type and send in (Raft, task #507):
 * in the bottom right on a desktop, centred on a phone (Frank, task #7). A phone's composer and its
 * tab bar both stand on the home indicator's inset, so the phone's toasts are lifted from it too and
 * keep the same gap above either with or without one. */
const desktopOffset = { ...offset, bottom: "calc(max(1rem, var(--spacing-safe-bottom)) + 4.5rem)" };
const phoneOffset = { ...offset, bottom: "calc(var(--spacing-safe-bottom) + 4.5rem)" };

export function AppToastProvider({ children }: { children: React.ReactNode }) {
  const desktop = useBreakpoint("md");

  return (
    <>
      {children}
      <Toaster
        position={desktop ? "bottom-right" : "bottom-center"}
        visibleToasts={3}
        hotkey={["F6"]}
        customAriaLabel={m.navigation_notifications()}
        offset={desktopOffset}
        mobileOffset={phoneOffset}
        style={toastStyle}
        closeButton
        icons={{
          success: <CheckCircle aria-hidden="true" className="size-4 text-success-primary" />,
          error: <AlertCircle aria-hidden="true" className="size-4 text-error-primary" />,
        }}
        toastOptions={{
          classNames: {
            toast: "group relative rounded-xl!",
            title: "text-sm! font-medium!",
            description: "text-xs! text-tertiary!",
            closeButton:
              "transition-opacity! duration-200! ease-out! pointer-fine:opacity-0! pointer-fine:group-hover:opacity-100! pointer-fine:group-focus-within:opacity-100! bg-tertiary! text-primary! border-none!",
            actionButton:
              "transition-[transform,background-color]! duration-200! ease-out! hover:bg-primary_hover! hover:text-secondary_hover! hover:scale-105! active:scale-95! bg-primary! text-secondary! ring-1! ring-primary! ring-inset! rounded-md! px-3! py-1.5!",
          },
        }}
      />
    </>
  );
}

/** How long a toast carrying an Undo stays: longer than the 4 s default so the action can be reached
 * (Material 3 suggests 4–10 s for a snackbar with an action). */
export const UNDO_TOAST_MS = 6000;

/** One success toast per title; `key` keeps two different items' toasts of the same title apart
 * (closing chat A then chat B must not replace A's Undo). */
function successId(title: string, key?: string) {
  return key === undefined ? `success:${title}` : `success:${title}:${key}`;
}

export const appToast = {
  info(
    title: string,
    options?: {
      durationMs?: number;
      action?: { label: string; onClick: () => void };
      description?: string;
      key?: string;
    },
  ) {
    toast(title, {
      id: successId(title, options?.key),
      duration: options?.durationMs,
      action: options?.action,
      description: options?.description,
    });
  },
  success(
    title: string,
    options?: {
      durationMs?: number;
      action?: { label: string; onClick: () => void };
      description?: string;
      key?: string;
    },
  ) {
    toast.success(title, {
      id: successId(title, options?.key),
      duration: options?.durationMs,
      action: options?.action,
      description: options?.description,
    });
  },
  /** Takes a success toast away early, for an Undo that no longer applies. */
  dismiss(title: string, key?: string) {
    toast.dismiss(successId(title, key));
  },
  /** A plain notice, one per title: something did not go as asked, but nothing failed. */
  notice(title: string) {
    toast(title, { id: `notice:${title}` });
  },
  /** Takes a notice or error toast away, for one that belongs to a page the viewer left. */
  dismissShown(title: string) {
    toast.dismiss(`notice:${title}`);
    toast.dismiss(`error:${title}`);
  },
  // A toast only confirms that an action failed; an error reference belongs under an inline
  // failure, never in a toast.
  error(title: string) {
    toast.error(title, { id: `error:${title}` });
  },
};

/** One object for the whole app, so an effect can depend on it without re-running. */
export function useAppToast() {
  return appToast;
}
