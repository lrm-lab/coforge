import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import {
  createPageBridge,
  type PageArtifact,
  type PageConfirm,
  type PageDisplayMode,
  type PageFrameSize,
  type PageSuggestHandler,
  type PageTheme,
  type PageViewer,
} from "./artifact-page-bridge";
import type { PageConfirmation } from "./artifact-page-confirm";
import type { PageLevel } from "./artifact-page-levels";
import { pageAssetsPort, pageDataPort } from "./artifact-page-ports";
import { readHostThemeTokens } from "./artifact-page-theme";

const currentTheme = (): PageTheme =>
  document.documentElement.classList.contains("dark-mode") ? "dark" : "light";

export function useArtifactPageBridge(input: {
  frame: RefObject<HTMLIFrameElement | null>;
  origin: string;
  viewer: PageViewer;
  level: PageLevel;
  artifact: PageArtifact;
  suggestions: RefObject<PageSuggestHandler | null>;
  displayMode?: PageDisplayMode;
  onInitialized?: () => void;
  onSizeChanged?: (size: PageFrameSize) => void;
}) {
  const { frame, origin, viewer, level, artifact, suggestions, displayMode = "panel" } = input;
  const toast = useAppToast();
  const [confirmation, setConfirmation] = useState<PageConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [found, setFound] = useState({ total: 0, active: 0 });
  const pending = useRef<PageConfirmation | null>(null);
  const onInitializedRef = useRef(input.onInitialized);
  onInitializedRef.current = input.onInitialized;
  const onSizeChangedRef = useRef(input.onSizeChanged);
  onSizeChangedRef.current = input.onSizeChanged;

  const bridge = useMemo(
    () =>
      createPageBridge(
        {
          viewer,
          artifact,
          level,
          displayMode,
          data: pageDataPort(artifact.id),
          assets: pageAssetsPort(artifact.id),
          theme: currentTheme,
          themeTokens: readHostThemeTokens,
          userActive: () => navigator.userActivation?.isActive ?? false,
          copyText: async (text) => {
            const copied = await copyText(text);
            if (copied) toast.success(m.doc_page_copied());
            else toast.error(m.conversation_copy_failed());
            return copied;
          },
          downloadFile: (file, name) => {
            const url = URL.createObjectURL(file);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = name;
            anchor.rel = "noopener";
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
          suggestComment: (request) => {
            const handled = pending.current === null && (suggestions.current?.(request) ?? false);
            if (!handled) toast.notice(m.doc_page_comment_unavailable());
            return handled;
          },
          reportError: setError,
          reportFind: setFound,
          frameStatus: () => setBlocked(true),
          onInitialized: () => onInitializedRef.current?.(),
          onPreviewEscape: () => {
            const iframe = frame.current;
            if (!iframe || document.activeElement !== iframe || pending.current) return;
            iframe
              .closest("dialog:modal[data-artifact-preview]")
              ?.dispatchEvent(new Event("cancel", { cancelable: true }));
          },
          onSizeChanged: (size) => onSizeChangedRef.current?.(size),
          now: () => Date.now(),
        },
        { origin, window: () => frame.current?.contentWindow ?? null },
      ),
    [origin, viewer, level, displayMode, artifact, frame, suggestions, toast],
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
    let lastTheme = currentTheme();
    const observer = new MutationObserver(() => {
      const nextTheme = currentTheme();
      if (nextTheme === lastTheme) return;
      lastTheme = nextTheme;
      bridge.notifyTheme();
    });
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
