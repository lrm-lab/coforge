import type { DaemonServiceManager } from "@lrm/coforge-daemon";

/** The service manager each supported platform registers the Coordinator service with. */
export const SERVICE_MANAGER_BY_PLATFORM = {
  darwin: "launchd",
  linux: "systemd-user",
  win32: "windows-task",
} as const satisfies Record<string, DaemonServiceManager>;
