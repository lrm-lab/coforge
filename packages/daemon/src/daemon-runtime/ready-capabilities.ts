import { kiroEnterpriseAuthSupported } from "#src/code-agent/kiro/auth-host";
import {
  REMINDER_CAPABILITY,
  RUNTIME_AUTH_CAPABILITY,
  RUNTIME_AUTH_STATUS_READ_CAPABILITY,
  KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  APP_CONFIG_CAPABILITY,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_TURN_INTERRUPT_CAPABILITY,
} from "@lrm/coforge-sdk/internal";
import { APP_REGISTRATION_NOTICE_CAPABILITY } from "@lrm/coforge-sdk/internal/app-registration-notice";
import {
  PI_CHAT_CAPABILITY,
  PI_CHAT_CONTROLS_CAPABILITY,
  PI_CHAT_FILES_CAPABILITY,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";

/** The ready handshake advertises controls separately so older Pi chat remains usable. */
export function readyCapabilities(
  migrations: boolean,
  runtimeAuth = false,
  platform = process.platform,
) {
  return [
    PI_CHAT_CAPABILITY,
    PI_CHAT_CONTROLS_CAPABILITY,
    PI_CHAT_FILES_CAPABILITY,
    REMINDER_CAPABILITY,
    APP_CONFIG_CAPABILITY,
    AGENT_TURN_INTERRUPT_CAPABILITY,
    APP_REGISTRATION_NOTICE_CAPABILITY,
    ...(runtimeAuth ? [RUNTIME_AUTH_CAPABILITY, RUNTIME_AUTH_STATUS_READ_CAPABILITY] : []),
    ...(runtimeAuth && kiroEnterpriseAuthSupported(platform)
      ? [KIRO_IDENTITY_CENTER_AUTH_CAPABILITY]
      : []),
    ...(migrations ? [AGENT_MIGRATION_CAPABILITY] : []),
  ];
}
