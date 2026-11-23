import { useCallback, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import { deLocalizeHref } from "#src/paraglide/runtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  decodeNotificationAvailableEvent,
  userConversationChannel,
  type NotificationAvailableEvent,
} from "#src/features/conversations/conversation-realtime";
import { browserNotificationPermission, showPageNotification } from "./browser-push";
import { browserInstallationId, claimBrowserNotification } from "./browser-notification-store";
import { isFreshNotification, pageOwnsNotification } from "./notification-routing";
import { getMessageNotification } from "./notifications.functions";

/**
 * Whether the page should even ask the server for a notification to show. Gates on the same
 * preference `BrowserPushLifecycle` reads plus a granted `Notification` permission — with either
 * missing there is nothing to show and no need to fetch.
 */
export function isInPageNotificationEnabled(input: {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
}): boolean {
  return input.enabled && input.permission === "granted";
}

/**
 * Whether to actually call `showNotification` once the recipient's notification has been fetched.
 * Skipped only while the tab is the visible, focused window already looking at the conversation the
 * notification is about — the member is already reading it, so an OS notification would be noise.
 */
export function shouldShowInPageNotification(input: {
  visible: boolean;
  focused: boolean;
  pathname: string;
  conversationPath: string;
}): boolean {
  return !(input.visible && input.focused && input.pathname === input.conversationPath);
}

export function InPageNotifications({
  enabled,
  viewerId,
  workspaceId,
}: {
  enabled: boolean;
  viewerId?: string;
  workspaceId?: string;
}) {
  const fetchNotification = useServerFn(getMessageNotification);
  const state = useRef({ enabled, viewerId, mounted: false });
  state.current.enabled = enabled;
  state.current.viewerId = viewerId;
  useEffect(() => {
    state.current.mounted = true;
    return () => {
      state.current.mounted = false;
    };
  }, []);

  const onPublication = useCallback(
    (publication: { data: unknown }) => {
      let event;
      try {
        event = decodeNotificationAvailableEvent(publication.data);
      } catch {
        return;
      }
      if (viewerId) void showInPageNotification(event, viewerId, state, fetchNotification);
    },
    [fetchNotification, viewerId],
  );

  useRealtimeSubscription({
    channel: enabled && viewerId && workspaceId ? userConversationChannel(viewerId) : undefined,
    onPublication,
  });

  return null;
}

async function showInPageNotification(
  event: NotificationAvailableEvent,
  viewerId: string,
  state: { current: { enabled: boolean; viewerId?: string; mounted: boolean } },
  fetchNotification: (input: {
    data: { messageId: string };
  }) => Promise<Awaited<ReturnType<typeof getMessageNotification>>>,
) {
  const eligible = () =>
    state.current.mounted &&
    state.current.viewerId === viewerId &&
    isInPageNotificationEnabled({
      enabled: state.current.enabled,
      permission: browserNotificationPermission(),
    }) &&
    isFreshNotification(event.at, Date.now());
  if (!eligible()) return;

  try {
    if (!(await pageOwnsNotification(event, browserInstallationId)) || !eligible()) return;

    const notification = await fetchNotification({ data: { messageId: event.messageId } });
    if (!notification || !eligible()) return;
    if (
      !shouldShowInPageNotification({
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        pathname: deLocalizeHref(window.location.pathname),
        conversationPath: notification.conversationPath,
      })
    )
      return;
    if ((await claimBrowserNotification(viewerId, event.messageId, event.at)) && eligible()) {
      await showPageNotification(notification, eligible);
    }
  } catch (cause) {
    console.warn("in-page notification unavailable", cause);
  }
}
