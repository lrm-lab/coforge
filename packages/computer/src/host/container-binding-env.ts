/** Every variable a cloud Computer container is started with (`containerEnv` in run-host.ts,
 * read by `prepareContainerBinding` in container-binding.ts). Imports nothing, so the isolated
 * test run can drop these names before any package's generated code exists. */
export const CONTAINER_BINDING_ENV_KEYS = [
  "COFORGE_DAEMON_API_KEY",
  "COFORGE_WORKSPACE_ID",
  "COFORGE_COMPUTER_ID",
  "COFORGE_SERVER_URL",
  "COFORGE_WORKSPACE_SLUG",
  "COFORGE_COMPUTER_NAME",
] as const;

/** The variables of one cloud Computer container, exactly `CONTAINER_BINDING_ENV_KEYS`. */
export type ContainerBindingEnv = Record<(typeof CONTAINER_BINDING_ENV_KEYS)[number], string>;
