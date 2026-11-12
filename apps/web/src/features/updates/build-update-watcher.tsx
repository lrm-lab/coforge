import { useEffect, useRef } from "react";

import { appToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";

import {
  buildUpdateStateAfterProbe,
  CLIENT_BUILD_ID,
  hasUnsavedTemporaryState,
  isChunkLoadError,
  type BuildUpdateState,
} from "./build-update";

export { isChunkLoadError } from "./build-update";

const BUILD_ID_PATH = "/api/build-id";
const BUILD_ID_POLL_MS = 5 * 60 * 1000;
const UPDATE_TOAST_KEY = "build-update";

let updateToastShown = false;

export function showBuildUpdateToast(): void {
  if (updateToastShown) return;
  updateToastShown = true;
  appToast.info(m.app_updated_title(), {
    action: { label: m.controls_refresh(), onClick: () => window.location.reload() },
    description: hasUnsavedTemporaryState() ? m.app_updated_unsaved_warning() : undefined,
    durationMs: Infinity,
    key: UPDATE_TOAST_KEY,
  });
}

async function fetchBuildId(): Promise<string | undefined> {
  try {
    const response = await fetch(BUILD_ID_PATH, { cache: "no-store" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { buildId?: unknown };
    return typeof body.buildId === "string" && body.buildId.length > 0 ? body.buildId : undefined;
  } catch {
    return undefined;
  }
}

export function BuildUpdateWatcher() {
  const state = useRef<BuildUpdateState>({ updateDetected: false });
  const inFlight = useRef(false);

  useEffect(() => {
    let disposed = false;
    const probe = async () => {
      if (disposed || inFlight.current || CLIENT_BUILD_ID === "development") return;
      if (document.visibilityState !== "visible") return;
      inFlight.current = true;
      const serverBuildId = await fetchBuildId();
      inFlight.current = false;
      if (disposed || serverBuildId === undefined) return;
      state.current = buildUpdateStateAfterProbe(state.current, CLIENT_BUILD_ID, serverBuildId);
      if (state.current.updateDetected) showBuildUpdateToast();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void probe();
    };
    const onOnline = () => void probe();
    const interval = window.setInterval(() => void probe(), BUILD_ID_POLL_MS);
    void probe();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    if (CLIENT_BUILD_ID === "development") return;
    const onError = (event: ErrorEvent) => {
      if (isChunkLoadError(event.error ?? event.message)) showBuildUpdateToast();
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) showBuildUpdateToast();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
