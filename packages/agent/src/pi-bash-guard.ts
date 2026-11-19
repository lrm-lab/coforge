import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PI_BASH_TIMEOUT_SECONDS = 300;
export const MAX_PI_BASH_TIMEOUT_SECONDS = 3_600;

export function createHardenedBashOperations(options?: {
  base?: BashOperations;
  shellPath?: string;
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
}): BashOperations {
  const base = options?.base ?? createLocalBashOperations({ shellPath: options?.shellPath });
  const defaultTimeout = options?.defaultTimeoutSeconds ?? DEFAULT_PI_BASH_TIMEOUT_SECONDS;
  const maxTimeout = options?.maxTimeoutSeconds ?? MAX_PI_BASH_TIMEOUT_SECONDS;
  return {
    exec(command, cwd, execOptions) {
      let timeout = execOptions.timeout;
      if (timeout === undefined) {
        timeout = defaultTimeout;
      } else if (Number.isFinite(timeout) && timeout > 0) {
        timeout = Math.min(timeout, maxTimeout);
      }
      return base.exec(command, cwd, { ...execOptions, timeout });
    },
  };
}
