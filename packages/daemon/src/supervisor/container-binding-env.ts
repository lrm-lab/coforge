/** Every variable a cloud Computer container is started with. This module imports nothing so
 * isolated test setup can remove these names before generated package code exists. */
export const CONTAINER_BINDING_ENV_KEYS = [
  "COFORGE_DAEMON_API_KEY",
  "COFORGE_WORKSPACE_ID",
  "COFORGE_COMPUTER_ID",
  "COFORGE_SERVER_URL",
  "COFORGE_WORKSPACE_SLUG",
  "COFORGE_COMPUTER_NAME",
  "COFORGE_REPLACE_CREDENTIAL",
] as const;

export type ContainerBindingEnv = Record<(typeof CONTAINER_BINDING_ENV_KEYS)[number], string>;
