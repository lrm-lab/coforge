import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";

export function usePhoneActivityScrollAnchor({
  phone,
  pane,
  opened,
  onOpen,
}: {
  phone: boolean;
  pane: HostedConversationTarget | undefined;
  opened: HostedConversationTarget | undefined;
  onOpen: (target: HostedConversationTarget) => void;
}) {
  const phoneDocScrollYRef = useRef(0);
  const hadPhonePaneRef = useRef(false);
  const phonePaneOpenRef = useRef(false);
  phonePaneOpenRef.current = phone && Boolean(pane);
  const listContentRef = useRef<HTMLDivElement>(null);
  const [paneExiting, setPaneExiting] = useState(false);

  const handleOpen = useCallback(
    (target: HostedConversationTarget) => {
      if (phone && (!opened || opened.taskAlone)) {
        phoneDocScrollYRef.current = window.scrollY;
      }
      onOpen(target);
    },
    [phone, opened, onOpen],
  );

  useEffect(() => {
    if (!phone) return;
    const syncPhoneDocScrollY = () => {
      if (
        !phonePaneOpenRef.current &&
        document.documentElement.scrollHeight > window.innerHeight + 1
      ) {
        phoneDocScrollYRef.current = window.scrollY;
      }
    };
    window.addEventListener("scroll", syncPhoneDocScrollY, { passive: true });
    return () => window.removeEventListener("scroll", syncPhoneDocScrollY);
  }, [phone]);

  useLayoutEffect(() => {
    const hasPhonePane = phone && Boolean(pane);
    const content = listContentRef.current;
    if (hasPhonePane && !hadPhonePaneRef.current) {
      setPaneExiting(false);
      const offset = phoneDocScrollYRef.current;
      if (content) {
        content.style.transform = offset > 0 ? `translate3d(0, ${-offset}px, 0)` : "";
      }
    } else if (!hasPhonePane && hadPhonePaneRef.current) {
      setPaneExiting(phone);
      if (content) content.style.transform = "";
    } else if (!phone && paneExiting) {
      setPaneExiting(false);
      if (content) content.style.transform = "";
    }
    hadPhonePaneRef.current = hasPhonePane;
  }, [phone, pane, paneExiting]);

  const onExitComplete = useCallback(() => setPaneExiting(false), []);

  return {
    listContentRef,
    paneExiting,
    onOpen: handleOpen,
    onExitComplete,
  };
}
