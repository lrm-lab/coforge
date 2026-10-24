import { createDevicePreference } from "./device-preference";
import { DEVICE_FLAG_HIDDEN } from "./device-flag";

/** Per-device preference: the busy Agents in the Chat list's header, and who is typing or replying
 * in chat. On unless this device stored "hide"; every reader renders only in the browser. */
const preference = createDevicePreference<boolean>({
  key: "coforge-live-agent-activity",
  parse: (stored) => stored !== DEVICE_FLAG_HIDDEN,
  serialize: (show) => (show ? "show" : DEVICE_FLAG_HIDDEN),
  fallback: true,
});

export const useLiveAgentActivity = preference.useValue;
