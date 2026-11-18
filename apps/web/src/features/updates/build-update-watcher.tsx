import { useEffect, useRef } from "react";

import { appNotice } from "#src/components/ui/notice-card";
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
const UPDATE_NOTICE_ID = "build-update";

let updateNoticeShown = false;

export function showBuildUpdateNotice(): void {
  if (updateNoticeShown) return;
  updateNoticeShown = true;
  appNotice.show({
    id: UPDATE_NOTICE_ID,
    title: m.app_updated_title(),
    body: hasUnsavedTemporaryState() ? m.app_updated_unsaved_warning() : m.app_updated_body(),
    actions: [
      { label: m.controls_later(), onPress: () => undefined },
      { label: m.controls_refresh(), onPress: () => window.location.reload() },
    ],
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
      if (state.current.updateDetected) showBuildUpdateNotice();
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
      if (isChunkLoadError(event.error ?? event.message)) showBuildUpdateNotice();
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) showBuildUpdateNotice();
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
