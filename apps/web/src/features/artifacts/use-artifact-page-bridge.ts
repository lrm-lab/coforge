import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import {
  createPageBridge,
  type PageArtifact,
  type PageTheme,
  type PageViewer,
} from "./artifact-page-bridge";
import { artifactComposerRequests } from "./artifact-page-composer";

export type LinkRequest = { url: string; settle: (allowed: boolean) => void };

const currentTheme = (): PageTheme =>
  document.documentElement.classList.contains("dark-mode") ? "dark" : "light";

export function useArtifactPageBridge(input: {
  frame: RefObject<HTMLIFrameElement | null>;
  origin: string;
  viewer: PageViewer;
  artifact: PageArtifact;
}) {
  const { frame, origin, viewer, artifact } = input;
  const toast = useAppToast();
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [found, setFound] = useState({ total: 0, active: 0 });
  const pendingLink = useRef<LinkRequest | null>(null);

  const bridge = useMemo(
    () =>
      createPageBridge(
        {
          viewer,
          artifact,
          theme: currentTheme,
          userActive: () => navigator.userActivation?.isActive ?? false,
          copyText: async (text) => {
            const copied = await copyText(text);
            if (copied) toast.success(m.doc_page_copied());
            else toast.error(m.conversation_copy_failed());
            return copied;
          },
          confirmOpenLink: (url) =>
            new Promise<boolean>((resolve) => {
              pendingLink.current?.settle(false);
              let settled = false;
              const request: LinkRequest = {
                url,
                settle: (allowed) => {
                  if (settled) return;
                  settled = true;
                  if (pendingLink.current === request) pendingLink.current = null;
                  setLinkRequest(null);
                  resolve(allowed);
                },
              };
              pendingLink.current = request;
              setLinkRequest(request);
            }),
          openLink: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
          openComposer: (request) => {
            const handled = artifactComposerRequests.request(request);
            if (!handled) toast.notice(m.doc_page_comment_unavailable());
            return handled;
          },
          reportError: setError,
          reportFind: setFound,
          frameStatus: () => setBlocked(true),
          now: () => Date.now(),
        },
        { origin, window: () => frame.current?.contentWindow ?? null },
      ),
    [origin, viewer, artifact, frame, toast],
  );

  useEffect(() => {
    const listener = (event: MessageEvent) => void bridge.handle(event);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [bridge]);

  useEffect(() => {
    const observer = new MutationObserver(() => bridge.notifyTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [bridge]);

  useEffect(() => () => pendingLink.current?.settle(false), []);

  return {
    bridge,
    linkRequest,
    error,
    dismissError: () => setError(null),
    blocked,
    found,
  };
}
