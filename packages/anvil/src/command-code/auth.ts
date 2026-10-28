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
/** The CLI waits 300 s for its browser callback; the margin lets that window close first. */
export const COMMAND_CODE_LOGIN_TIMEOUT_MS = 330_000;
export const COMMAND_CODE_LOGOUT_TIMEOUT_MS = 20_000;
/** `cmd login` prints this when it cannot open a browser or start its callback server. */
const MANUAL_KEY_PROMPT = /Paste your API key/;
/** Fixed detail codes: the web maps them to localized text, so no free text leaves the daemon. */
export const COMMAND_CODE_BROWSER_UNAVAILABLE_DETAIL = "command_code_browser_unavailable";
export const COMMAND_CODE_API_KEY_ENV_DETAIL = "command_code_api_key_env";

export interface CommandCodeAuthProcess {
  readonly output: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  dispose(): Promise<void>;
}
export interface CommandCodeAuthHost {
  runStatus(cwd: string, timeoutMs: number): Promise<{ output: string; exitCode: number }>;
  spawn(args: readonly string[], cwd: string): CommandCodeAuthProcess;
  /** Presence only: whether the daemon environment sets COMMAND_CODE_API_KEY. The value is never read. */
  apiKeyEnvironmentSet(): boolean;
}

/** Native Command Code login policy; the CLI writes the key itself, so the daemon never reads it. */
export class CommandCodeRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.COMMAND_CODE;
  #active?: { abort: AbortController; done: Promise<RuntimeAuthLoginResult> };
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
    options: Parameters<RuntimeAuthAdapter["startLogin"]>[0],
    interaction: RuntimeAuthLoginInteraction,
  ): Promise<RuntimeAuthLoginResult> {
    if (this.#active) return Promise.resolve({ status: "busy" });
    const abort = new AbortController();
    const cancel = () => abort.abort();
    interaction.signal?.addEventListener("abort", cancel, { once: true });
    if (interaction.signal?.aborted) abort.abort();
    const done = this.#login(options, abort.signal).finally(() => {
      interaction.signal?.removeEventListener("abort", cancel);
      this.#active = undefined;
    });
    this.#active = { abort, done };
    return done;
  }
  async #login(
    options: Parameters<RuntimeAuthAdapter["startLogin"]>[0],
    signal: AbortSignal,
  ): Promise<RuntimeAuthLoginResult> {
    if (signal.aborted) return { status: "cancelled" };
    const child = this.host.spawn(["login"], options.workingDirectory);
    const stopped = Promise.withResolvers<never>();
    const stop = () => stopped.reject(new Error("Command Code login cancelled"));
    signal.addEventListener("abort", stop, { once: true });
    let timedOut = false;
    try {
      return await withDeadline(
        Promise.race([this.#waitForLogin(child, options.workingDirectory), stopped.promise]),
        options.timeoutMs ?? COMMAND_CODE_LOGIN_TIMEOUT_MS,
        () => {
          timedOut = true;
          return new Error("Command Code login timed out");
        },
      );
    } catch {
      if (timedOut) return { status: "failed", reason: "timed_out" };
      if (signal.aborted) return { status: "cancelled" };
      return { status: "failed", reason: "interaction_failed" };
    } finally {
      signal.removeEventListener("abort", stop);
      await child.dispose();
    }
  }
  async #waitForLogin(
    child: CommandCodeAuthProcess,
    workingDirectory: string,
  ): Promise<RuntimeAuthLoginResult> {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of child.output) {
      text += decoder.decode(chunk, { stream: true });
      if (MANUAL_KEY_PROMPT.test(Bun.stripANSI(text)))
        return {
          status: "failed",
          reason: "interaction_failed",
          detail: COMMAND_CODE_BROWSER_UNAVAILABLE_DETAIL,
        };
    }
    if ((await child.exited) !== 0) return { status: "failed", reason: "process_failed" };
    const authStatus = await this.readStatus({ workingDirectory });
    return authStatus.state === "logged_in"
      ? { status: "logged_in", authStatus }
      : { status: "failed", reason: "not_logged_in" };
  }
  async submitCode(): Promise<void> {
    throw new Error("Command Code login is completed in a browser on this machine");
  }
  async cancel(): Promise<void> {
    const active = this.#active;
    active?.abort.abort();
    await active?.done;
  }
  async logout(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthLogoutResult> {
    const child = this.host.spawn(["logout"], options.workingDirectory);
    let timedOut = false;
    try {
      const [, code] = await withDeadline(
        Promise.all([new Response(child.output).text(), child.exited]),
        options.timeoutMs ?? COMMAND_CODE_LOGOUT_TIMEOUT_MS,
        () => {
          timedOut = true;
          return new Error("Command Code logout timed out");
        },
      );
      if (code !== 0) return { status: "failed", reason: "process_failed" };
      const authStatus = await this.readStatus(options);
      if (authStatus.state === "logged_out") return { status: "logged_out", authStatus };
      if (authStatus.state === "logged_in")
        return this.host.apiKeyEnvironmentSet()
          ? {
              status: "failed",
              reason: "still_logged_in",
              detail: COMMAND_CODE_API_KEY_ENV_DETAIL,
            }
          : { status: "failed", reason: "still_logged_in" };
      return { status: "failed", reason: "process_failed" };
    } catch {
      return { status: "failed", reason: timedOut ? "timed_out" : "process_failed" };
    } finally {
      await child.dispose();
    }
  }
}
