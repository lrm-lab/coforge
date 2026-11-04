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

/** On a desktop the toasts sit in the bottom right, over a conversation's composer and its send
 * button: they start above a one-line composer, so the moment after an action (an Undo shown for
 * ten seconds) leaves the composer free to type and send in (Raft, task #507). */
const desktopOffset = { ...offset, bottom: "calc(max(1rem, var(--spacing-safe-bottom)) + 4.5rem)" };

export function AppToastProvider({ children }: { children: React.ReactNode }) {
  const desktop = useBreakpoint("md");

  return (
    <>
      {children}
      <Toaster
        position={desktop ? "bottom-right" : "top-center"}
        visibleToasts={3}
        hotkey={["F6"]}
        customAriaLabel={m.navigation_notifications()}
        offset={desktopOffset}
        mobileOffset={offset}
        style={toastStyle}
        icons={{
          success: <CheckCircle aria-hidden="true" className="size-4 text-success-primary" />,
          error: <AlertCircle aria-hidden="true" className="size-4 text-error-primary" />,
        }}
        toastOptions={{
          classNames: {
            toast: "rounded-xl!",
            title: "text-sm! font-medium!",
            description: "text-xs! text-tertiary!",
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

const appToast = {
  success(
    title: string,
    options?: {
      durationMs?: number;
      action?: { label: string; onClick: () => void };
      key?: string;
    },
  ) {
    toast.success(title, {
      id: successId(title, options?.key),
      duration: options?.durationMs,
      action: options?.action,
    });
  },
  /** Takes a success toast away early, for an Undo that no longer applies. */
  dismiss(title: string, key?: string) {
    toast.dismiss(successId(title, key));
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
