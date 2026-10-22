import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PiChatView } from "./pi-chat-state";

export function usePiChatScroll(revision: unknown, ready: boolean, viewport: PiChatView) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const follow = useRef(viewport.follow);
  const prepend = useRef<{ height: number; top: number }>(undefined);
  const [away, setAway] = useState(false);
  const measure = () => {
    const node = scroll.current;
    if (!node || !initialized.current) return;
    const away = node.scrollHeight - node.scrollTop - node.clientHeight > 80;
    setAway(away);
    viewport.top = node.scrollTop;
    viewport.follow = follow.current;
  };
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !ready) return;
    if (!initialized.current) {
      node.scrollTop = viewport.follow ? node.scrollHeight : viewport.top;
      initialized.current = true;
    } else if (prepend.current) {
      node.scrollTop = prepend.current.top + node.scrollHeight - prepend.current.height;
      prepend.current = undefined;
    } else if (follow.current) node.scrollTop = node.scrollHeight;
    measure();
  }, [revision, ready]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (initialized.current && follow.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
      measure();
    });
    if (scroll.current) observer.observe(scroll.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return {
    scroll,
    content,
    away,
    onScroll() {
      const node = scroll.current;
      if (!node || !initialized.current) return;
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 80;
      measure();
    },
    capturePrepend() {
      const node = scroll.current;
      if (!node) return;
      follow.current = false;
      prepend.current = { height: node.scrollHeight, top: node.scrollTop };
    },
    pauseFollowing() {
      follow.current = false;
      measure();
    },
    followLatest() {
      follow.current = true;
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
      measure();
    },
  };
}
