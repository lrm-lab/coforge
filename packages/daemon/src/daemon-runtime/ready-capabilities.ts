import {
  REMINDER_CAPABILITY,
  APP_CONFIG_CAPABILITY,
  AGENT_MIGRATION_CAPABILITY,
} from "@lrm/coforge-sdk/internal";
import {
  PI_CHAT_CAPABILITY,
  PI_CHAT_CONTROLS_CAPABILITY,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";

/** The ready handshake advertises controls separately so older Pi chat remains usable. */
export function readyCapabilities(migrations: boolean) {
  return [
    PI_CHAT_CAPABILITY,
    PI_CHAT_CONTROLS_CAPABILITY,
    REMINDER_CAPABILITY,
    APP_CONFIG_CAPABILITY,
    ...(migrations ? [AGENT_MIGRATION_CAPABILITY] : []),
  ];
}
