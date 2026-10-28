import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type {
  RuntimeAuthAdapter,
  RuntimeAuthLoginInteraction,
  RuntimeAuthLoginResult,
  RuntimeAuthLogoutResult,
  RuntimeAuthStatus,
} from "#src/contract";
import { withDeadline } from "#src/deadline";
import { asRecord } from "#src/json-record";

/** `cmd status` prints "Not authenticated" on stderr. `--json` puts `authenticated` on stdout. */
function commandCodeLoggedOut(output: string): boolean {
  try {
    return asRecord(JSON.parse(output))?.authenticated === false;
  } catch {
    return false;
  }
}

export const COMMAND_CODE_AUTH_STATUS_TIMEOUT_MS = 20_000;
export interface CommandCodeAuthHost {
  runStatus(cwd: string, timeoutMs: number): Promise<{ output: string; exitCode: number }>;
}
export class CommandCodeRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.COMMAND_CODE;
  constructor(private readonly host: CommandCodeAuthHost) {}
  async readStatus(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthStatus> {
    try {
      const result = await withDeadline(
        this.host.runStatus(
          options.workingDirectory,
          options.timeoutMs ?? COMMAND_CODE_AUTH_STATUS_TIMEOUT_MS,
        ),
        options.timeoutMs ?? COMMAND_CODE_AUTH_STATUS_TIMEOUT_MS,
        () => new Error("Command Code auth status timed out"),
      );
      if (result.exitCode === 0) return { provider: this.provider, state: "logged_in" };
      if (result.exitCode === 1 && commandCodeLoggedOut(result.output))
        return { provider: this.provider, state: "logged_out" };
      return { provider: this.provider, state: "unknown" };
    } catch {
      return { provider: this.provider, state: "unknown" };
    }
  }
  startLogin(
    _options: Parameters<RuntimeAuthAdapter["startLogin"]>[0],
    _interaction: RuntimeAuthLoginInteraction,
  ): Promise<RuntimeAuthLoginResult> {
    return Promise.resolve({
      status: "unsupported",
      reason: "unsupported_installation",
      detail: "Run cmd login in the user's terminal",
    });
  }
  async submitCode(): Promise<void> {
    throw new Error("Command Code login is completed in the user's terminal");
  }
  async cancel(): Promise<void> {}
  async logout(
    _options: Parameters<RuntimeAuthAdapter["logout"]>[0],
  ): Promise<RuntimeAuthLogoutResult> {
    return {
      status: "unsupported",
      reason: "unsupported_installation",
      detail: "Run cmd logout in the user's terminal",
    };
  }
}
