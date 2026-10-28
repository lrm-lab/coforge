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
import { runtimeAuthAccount } from "#src/runtime-auth-status";

/** `cmd status` prints "Not authenticated" on stderr. `--json` puts `authenticated` on stdout. */
function commandCodeLoggedOut(output: string): boolean {
  try {
    return asRecord(JSON.parse(output))?.authenticated === false;
  } catch {
    return false;
  }
}

/** `cmd whoami` prints a colored human report; only its email is read, and the address itself
 * goes no further than `maskAccountLabel`. JSON output is accepted when the CLI emits it. */
function commandCodeEmail(output: string): string | undefined {
  const text = Bun.stripANSI(output);
  try {
    const email = asRecord(JSON.parse(text))?.email;
    if (typeof email === "string") return email;
  } catch {
    // Not JSON: the colored report's `Email:` line below.
  }
  return /^\s*Email:\s*(\S+)\s*$/im.exec(text)?.[1];
}

export const COMMAND_CODE_AUTH_STATUS_TIMEOUT_MS = 20_000;
export interface CommandCodeAuthHost {
  runStatus(cwd: string, timeoutMs: number): Promise<{ output: string; exitCode: number }>;
  /** `cmd whoami` reaches the account service; the adapter runs it once per signed-in account. */
  runWhoami(cwd: string, timeoutMs: number): Promise<{ output: string; exitCode: number }>;
  /** The only form of the account's email that leaves the status read. */
  maskAccountLabel(value: string): string | undefined;
}
/**
 * The masked email the last `cmd whoami` produced, keyed by a hash of the status `user`, so
 * polling `readStatus` does not hit the account service; a changed `user` names a new account
 * and re-reads it. The raw `user` (which may name an email) and the address are never kept.
 */
let whoamiCache: { identity: string; maskedLabel?: string } | undefined;

export class CommandCodeRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.COMMAND_CODE;
  constructor(private readonly host: CommandCodeAuthHost) {}
  async readStatus(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthStatus> {
    const timeoutMs = options.timeoutMs ?? COMMAND_CODE_AUTH_STATUS_TIMEOUT_MS;
    try {
      const result = await withDeadline(
        this.host.runStatus(options.workingDirectory, timeoutMs),
        timeoutMs,
        () => new Error("Command Code auth status timed out"),
      );
      if (result.exitCode === 0) {
        let status: Record<string, unknown> | undefined;
        try {
          status = asRecord(JSON.parse(result.output));
        } catch {
          // `status --json` with a torn payload still reads as logged in below.
        }
        const identity = String(Bun.hash(JSON.stringify(status?.user ?? null)));
        if (whoamiCache?.identity !== identity)
          whoamiCache = {
            identity,
            maskedLabel: await this.#accountLabel(
              options.workingDirectory,
              timeoutMs,
              status?.user,
            ),
          };
        return {
          provider: this.provider,
          state: "logged_in",
          ...runtimeAuthAccount({ maskedLabel: whoamiCache.maskedLabel }),
        };
      }
      if (result.exitCode === 1 && commandCodeLoggedOut(result.output))
        return { provider: this.provider, state: "logged_out" };
      return { provider: this.provider, state: "unknown" };
    } catch {
      return { provider: this.provider, state: "unknown" };
    }
  }
  /** The masked email for this account, or the status `user` masked when `whoami` fails; an
   * unmaskable value (e.g. a bare name) carries no label rather than leaking. */
  async #accountLabel(cwd: string, timeoutMs: number, user: unknown): Promise<string | undefined> {
    try {
      const result = await withDeadline(
        this.host.runWhoami(cwd, timeoutMs),
        timeoutMs,
        () => new Error("Command Code whoami timed out"),
      );
      if (result.exitCode === 0) {
        const email = commandCodeEmail(result.output);
        const masked = email && this.host.maskAccountLabel(email);
        if (masked) return masked;
      }
    } catch {
      // Offline or a CLI failure: the status `user` below.
    }
    const name = asRecord(user)?.name;
    return typeof name === "string" ? this.host.maskAccountLabel(name) : undefined;
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
