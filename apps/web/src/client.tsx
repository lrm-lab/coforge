import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

import { CLIENT_BUILD_ID } from "#src/features/updates/build-update";
import { ensureTemporal } from "#src/lib/temporal-support";
import { syncThemeColor } from "#src/lib/theme-color";

if (typeof document !== "undefined") {
  syncThemeColor(document.documentElement.classList.contains("dark-mode"));
  // Safari on iOS applies :active styles to touch taps only when the document listens for touchstart.
  document.addEventListener("touchstart", () => {}, { passive: true });
}

if (
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  CLIENT_BUILD_ID !== "development"
) {
  const registerSw = () => {
    const swUrl = `/service-worker.js?v=${encodeURIComponent(CLIENT_BUILD_ID)}`;
    void navigator.serviceWorker.register(swUrl, { scope: "/" }).catch(() => {});
  };
  if (document.readyState === "complete") {
    registerSw();
  } else {
    window.addEventListener("load", registerSw, { once: true });
  }
}

void ensureTemporal()
  .catch((cause: unknown) => console.error("Temporal polyfill could not be loaded", cause))
  .finally(() => {
    startTransition(() => {
      hydrateRoot(
        document,
        <StrictMode>
          <StartClient />
        </StrictMode>,
      );
    });
  });
