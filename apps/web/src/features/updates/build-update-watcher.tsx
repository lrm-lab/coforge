import { useEffect } from "react";

import { appNotice } from "#src/components/ui/notice-card";
import { m } from "#src/paraglide/messages";

import {
  CLIENT_BUILD_ID,
  createBuildUpdateController,
  hasUnsavedTemporaryState,
  isChunkLoadError,
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

const buildUpdateController = createBuildUpdateController({
  clientBuildId: CLIENT_BUILD_ID,
  fetchBuildId,
  isOffline: () => typeof navigator !== "undefined" && navigator.onLine === false,
  onUpdateDetected: showBuildUpdateNotice,
});

export function reportChunkLoadError(): void {
  void buildUpdateController.handleChunkLoadError();
}

export function BuildUpdateWatcher() {
  useEffect(() => {
    let disposed = false;
    const probe = () => {
      if (disposed || document.visibilityState !== "visible") return;
      void buildUpdateController.probe();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") probe();
    };
    const onOnline = () => probe();
    const interval = window.setInterval(probe, BUILD_ID_POLL_MS);
    probe();
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
      if (isChunkLoadError(event.error ?? event.message)) reportChunkLoadError();
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) reportChunkLoadError();
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
