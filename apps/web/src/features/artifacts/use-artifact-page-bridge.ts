import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import {
  createPageBridge,
  type PageArtifact,
  type PageConfirm,
  type PageTheme,
  type PageViewer,
} from "./artifact-page-bridge";
import { artifactComposerRequests } from "./artifact-page-composer";
import type { PageConfirmation } from "./artifact-page-confirm";
import type { PageLevel } from "./artifact-page-levels";
import { pageAssetsPort, pageDataPort } from "./artifact-page-ports";

const currentTheme = (): PageTheme =>
  document.documentElement.classList.contains("dark-mode") ? "dark" : "light";

export function useArtifactPageBridge(input: {
  frame: RefObject<HTMLIFrameElement | null>;
  origin: string;
  viewer: PageViewer;
  level: PageLevel;
  artifact: PageArtifact;
}) {
  const { frame, origin, viewer, level, artifact } = input;
  const toast = useAppToast();
  const [confirmation, setConfirmation] = useState<PageConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [found, setFound] = useState({ total: 0, active: 0 });
  const pending = useRef<PageConfirmation | null>(null);

  const bridge = useMemo(
    () =>
      createPageBridge(
        {
          viewer,
          artifact,
          level,
          data: pageDataPort(artifact.id),
          assets: pageAssetsPort(artifact.id),
          theme: currentTheme,
          userActive: () => navigator.userActivation?.isActive ?? false,
          copyText: async (text) => {
            const copied = await copyText(text);
            if (copied) toast.success(m.doc_page_copied());
            else toast.error(m.conversation_copy_failed());
            return copied;
          },
          confirm: (request: PageConfirm) =>
            new Promise<boolean>((resolve) => {
              pending.current?.settle(false);
              let settled = false;
              const next: PageConfirmation = {
                request,
                settle: (allowed) => {
                  if (settled) return;
                  settled = true;
                  if (pending.current === next) pending.current = null;
                  setConfirmation(null);
                  resolve(allowed);
                },
              };
              pending.current = next;
              setConfirmation(next);
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
    [origin, viewer, level, artifact, frame, toast],
  );

  useEffect(() => {
    const listener = (event: MessageEvent) => void bridge.handle(event);
    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
      bridge.dispose();
    };
  }, [bridge]);

  useEffect(() => {
    const observer = new MutationObserver(() => bridge.notifyTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [bridge]);

  useEffect(() => () => pending.current?.settle(false), []);

  return {
    bridge,
    confirmation,
    error,
    dismissError: () => setError(null),
    blocked,
    found,
  };
}
