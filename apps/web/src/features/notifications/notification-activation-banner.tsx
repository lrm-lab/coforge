import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { BellRinging01, Check } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { syncBrowserPushSubscription } from "./browser-push";
import { useNotificationsAskable } from "./notification-permission";
import { saveBrowserNotificationPreference, subscribeBrowserPush } from "./notifications.functions";
import "./notification-activation-banner.css";

/** What the banner needs from the Workspace layout. Absent (a pane rendered on its own), there is
 * no banner. */
export const NotificationActivationContext = createContext<{
  publicKey: string | null;
  workspaceSlug: string;
} | null>(null);

/** Per tab, as on Raft: a dismissed banner stays away until the browser session ends. */
const DISMISSED_KEY = "coforge:notification-activation-banner-dismissed:v1";

function readDismissed() {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage off: the banner still goes for this page.
  }
}

/** Stands in for `{settings}` while the hidden-for-now sentence is split around its link. */
const SETTINGS_SLOT = "\u0000";

/**
 * Raft's prompt to turn on notifications, right above the main composer: shown while the browser
 * can take Web Push and has not been asked yet, until dismissed for this tab. Enable asks for the
 * permission, subscribes this browser and turns the account's notifications on, as Settings does.
 * Dismiss leaves a 3-second line pointing at Settings, then returns focus to the composer. It
 * shares the composer frame's side margins (`COMPOSER_FRAME_CLASS`), so the two line up.
 */
export function NotificationActivationBanner() {
  const context = useContext(NotificationActivationContext);
  return context ? <Banner {...context} /> : null;
}

function Banner({ publicKey, workspaceSlug }: { publicKey: string | null; workspaceSlug: string }) {
  const router = useRouter();
  const subscribe = useServerFn(subscribeBrowserPush);
  const savePreference = useServerFn(saveBrowserNotificationPreference);
  const ref = useRef<HTMLDivElement>(null);
  // Known in the browser only, so the server render and hydration agree on showing nothing.
  const [askable, recheckAskable] = useNotificationsAskable();
  const [dismissed, setDismissed] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<"unavailable" | "generic" | null>(null);

  useEffect(() => setDismissed(readDismissed()), []);

  if (!askable || (dismissed && !confirming)) return null;

  const returnFocus = () => {
    if (ref.current?.contains(document.activeElement))
      ref.current.parentElement?.querySelector("textarea")?.focus();
  };

  async function enable() {
    setEnabling(true);
    setError(null);
    try {
      if (!publicKey) {
        setError("unavailable");
        return;
      }
      const granted = (await Notification.requestPermission()) === "granted";
      if (granted) {
        await syncBrowserPushSubscription(publicKey, (data) => subscribe({ data }));
        await savePreference({ data: { enabled: true } });
        void router.invalidate();
      }
    } catch (cause) {
      console.warn("enabling notifications from the banner failed", cause);
      setError("generic");
    } finally {
      recheckAskable();
      setEnabling(false);
    }
  }

  if (confirming) {
    const [before = "", after = ""] = m
      .notification_activation_hidden({ settings: SETTINGS_SLOT })
      .split(SETTINGS_SLOT);
    return (
      <div
        ref={ref}
        role="status"
        className="relative mx-4 mt-2 flex items-start gap-2 overflow-hidden rounded-xl md:mx-6 border border-utility-blue-200 bg-utility-blue-50 px-3 py-2.5 pb-3 text-sm text-primary"
      >
        <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-primary" />
        <p className="min-w-0 font-semibold">
          {before}
          <Link
            to="/w/$workspaceSlug/settings"
            params={{ workspaceSlug }}
            search={{ section: "notifications" }}
            className="underline-offset-2 outline-focus-ring hover:underline focus-visible:outline-2"
          >
            {m.notification_activation_settings()}
          </Link>
          {after}
        </p>
        <div
          aria-hidden="true"
          className="notification-activation-progress absolute inset-x-0 bottom-0 h-1 bg-fg-primary"
          onAnimationEnd={() => {
            returnFocus();
            setConfirming(false);
          }}
        />
      </div>
    );
  }

  const actions = (
    <>
      <Button
        size="xs"
        color="secondary"
        onPress={() => {
          writeDismissed();
          setError(null);
          setDismissed(true);
          setConfirming(true);
        }}
      >
        {m.notification_activation_dismiss()}
      </Button>
      <Button size="xs" color="primary" isDisabled={enabling} onPress={() => void enable()}>
        {enabling ? m.notification_activation_enabling() : m.notification_activation_enable()}
      </Button>
    </>
  );
  return (
    // One line: the bell, one sentence, and the two buttons as a pair, secondary and primary, on
    // the right. The buttons stay beside the sentence only while it fits on its line whole; with
    // less room (a phone, the pane beside an open thread, or a longer translation) they wrap onto
    // their own row, right-aligned, as they do under an error, so the sentence is never squeezed.
    <div ref={ref} className="mx-4 mt-2 md:mx-6">
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-xl border border-utility-blue-200 bg-utility-blue-50 px-3 py-2 text-sm">
        <div
          className={cx(
            "flex min-w-0 grow basis-auto items-start gap-2 text-primary",
            error && "basis-full",
          )}
        >
          <BellRinging01 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-primary" />
          <div className="min-w-0">
            <p>{m.notification_activation_message()}</p>
            {error && (
              <p role="alert" className="mt-1 font-semibold">
                {error === "unavailable"
                  ? m.notification_activation_error_unavailable()
                  : m.notification_activation_error_generic()}
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-2">{actions}</div>
      </div>
    </div>
  );
}
