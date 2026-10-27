import type { ClaudeAuthHost } from "./host";
import { getLogger } from "@logtape/logtape";
import { scrubRuntimeErrorText } from "#src/runtime-error-text";
import {
  normalizeRuntimeAuthCode,
  type RuntimeAuthAdapter,
  type RuntimeAuthLoginEvent,
  type RuntimeAuthLoginInteraction,
  type RuntimeAuthLoginResult,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthSecretSink,
  type RuntimeAuthStatus,
} from "#src/contract";
import { asRecord } from "#src/json-record";
import { runtimeAuthAccount } from "#src/runtime-auth-status";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CLAUDE_CODE, "auth"]);

export const CLAUDE_LOGIN_TIMEOUT_MS = 16 * 60 * 1_000;
const CLAUDE_AUTH_URL_WAIT_MS = 1_000;
export const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 20_000;
export const CLAUDE_LOGOUT_TIMEOUT_MS = 60_000;
/** First Claude Code release whose `auth login` accepts the code pasted back on stdin. */
export const CLAUDE_LOGIN_MINIMUM_VERSION = "2.1.126";

/** The `claude auth ...` child the adapter drives; a seam so tests script its output. */
export interface ClaudeAuthProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(text: string): void;
  kill(): void;
}
export type ClaudeAuthProcessFactory = (
  command: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string>> },
) => ClaudeAuthProcess;

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "gu");
// The link counts only once its line is complete: a chunk may end in the middle of it.
const AUTH_URL = /If the browser didn't open, visit:\s*(\S+)[\r\n]/u;
const CODE_PROMPT = /Paste code here if prompted\s*>/u;
const MISSING_AUTH_URL_DETAIL =
  "Claude Code did not provide a sign-in link before asking for a code";
const INVALID_CODE_LINES = /^Invalid code\b/gmu;
const LOGIN_SUCCESSFUL = /Login successful\b/u;
const LOGIN_FAILED = /Login failed:[ \t]*(.*)$/mu;
const MAX_CODE_ATTEMPTS = 5;
const AUTH_URL_INSTRUCTIONS =
  "Open this URL and sign in; if the page then shows a code, paste it back.";
/** Only Anthropic's own sign-in pages are ever shown to the person as a link. */
const AUTH_HOSTS = ["claude.com", "claude.ai", "anthropic.com"];

function anthropicUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const trusted = AUTH_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    return url.protocol === "https:" && trusted ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function detail(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.replace(/\p{Cc}/gu, " ").slice(0, 512);
}

/** A child that could not even start: a missing executable is "not installed", not a failed try. */
function notRunnable(error: unknown) {
  if ((error as { code?: string }).code === "ENOENT")
    return { status: "unsupported", reason: "not_installed" } as const;
  return {
    status: "failed",
    reason: "process_failed",
    detail: detail((error as Error).message),
  } as const;
}

/** Drives Claude Code's own `claude auth` commands behind the provider-neutral auth seam. */
export class ClaudeRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.CLAUDE_CODE;
  readonly #host: ClaudeAuthHost;
  readonly #executable: string;
  readonly #create: ClaudeAuthProcessFactory;
  #active?: { id: string; process: ClaudeAuthProcess; cancelled: boolean };

  constructor(options: {
    host: ClaudeAuthHost;
    command?: string;
    create?: ClaudeAuthProcessFactory;
  }) {
    this.#host = options.host;
    this.#executable = options.command ?? "claude";
    this.#create =
      options.create ?? ((command, options) => this.#host.createAuthProcess(command, options));
  }

  get activeOperationId(): string | undefined {
    return this.#active?.id;
  }

  async #run(
    args: readonly string[],
    options: { workingDirectory: string; timeoutMs?: number },
  ): Promise<{ text: string; exitCode: number }> {
    const process = this.#create([this.#executable, ...args], {
      cwd: options.workingDirectory,
      env: this.#host.buildAuthEnvironment(),
    });
    const timer = setTimeout(
      () => process.kill(),
      options.timeoutMs ?? CLAUDE_AUTH_STATUS_TIMEOUT_MS,
    );
    try {
      const [text, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
      ]);
      return { text, exitCode };
    } finally {
      clearTimeout(timer);
    }
  }

  async readStatus(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthStatus> {
    const provider = RUNTIME_PROVIDER.CLAUDE_CODE;
    let output: { text: string; exitCode: number };
    try {
      output = await this.#run(["auth", "status", "--json"], options);
    } catch (error) {
      logger.info("Claude Code login status read failed", {
        detail: scrubRuntimeErrorText(error instanceof Error ? error.message : String(error)),
      });
      if ((error as { code?: string }).code === "ENOENT")
        return { provider, state: "unavailable", unavailableReason: "not_installed" };
      return { provider, state: "unknown" };
    }
    let parsed: Readonly<Record<string, unknown>> | undefined;
    try {
      parsed = asRecord(JSON.parse(output.text));
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed.loggedIn !== "boolean") {
      logger.info("Claude Code login status unknown", {
        exitCode: output.exitCode,
        reason: "invalid_status_output",
      });
      return { provider, state: "unknown" };
    }
    if (!parsed.loggedIn) return { provider, state: "logged_out" };
    return {
      provider,
      state: "logged_in",
      ...runtimeAuthAccount({
        maskedLabel:
          typeof parsed.email === "string" ? this.#host.maskAccountLabel(parsed.email) : undefined,
        planLabel: parsed.subscriptionType,
        methodLabel: parsed.authMethod,
      }),
    };
  }

  async startLogin(
    options: { workingDirectory: string; timeoutMs?: number; onSecret?: RuntimeAuthSecretSink },
    interaction: RuntimeAuthLoginInteraction,
  ): Promise<RuntimeAuthLoginResult> {
    if (interaction.signal?.aborted) return { status: "cancelled" };
    if (this.#active) return { status: "busy" };
    const tooOld = await this.#versionBelowFloor(options.workingDirectory);
    if (interaction.signal?.aborted) return { status: "cancelled" };
    if (tooOld)
      return {
        status: "unsupported",
        reason: "version_unsupported",
        detail: `Claude Code ${CLAUDE_LOGIN_MINIMUM_VERSION} or newer is required to sign in from the Web`,
      };
    if (this.#active) return { status: "busy" };
    const id = crypto.randomUUID();
    let process: ClaudeAuthProcess;
    try {
      process = this.#create([this.#executable, "auth", "login"], {
        cwd: options.workingDirectory,
        env: this.#host.buildAuthEnvironment(),
      });
    } catch (error) {
      return notRunnable(error);
    }
    const active = { id, process, cancelled: false };
    this.#active = active;
    let codeSent = false;
    let untrustedLink = false;
    let interactionFailed: string | undefined;
    let loginFailure: string | undefined;
    let reportedSuccess = false;
    let codePromptSeen = false;
    let missingAuthUrl = false;
    let authUrlWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | undefined;
    const settled = Promise.withResolvers<"timeout" | "cancelled" | "exited">();
    const timer = setTimeout(() => {
      process.kill();
      settled.resolve("timeout");
    }, options.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS);
    const abort = () => {
      active.cancelled = true;
      process.kill();
      settled.resolve("cancelled");
    };
    interaction.signal?.addEventListener("abort", abort, { once: true });
    void process.exited
      .then((code) => (exitCode = code))
      .catch(() => undefined)
      .then(() => settled.resolve("exited"));

    const fail = (reason: string) => {
      interactionFailed = detail(reason) ?? "interaction failed";
      process.kill();
    };
    const failMissingAuthUrl = () => {
      missingAuthUrl = true;
      fail(MISSING_AUTH_URL_DETAIL);
    };
    const emit = (event: RuntimeAuthLoginEvent) => {
      try {
        interaction.onEvent(event);
      } catch (error) {
        fail((error as Error).message);
      }
    };
    /** Asks the person for the code and hands it to the CLI; an empty paste is asked for again. */
    const askForCode = async (message: string) => {
      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !interactionFailed; attempt += 1) {
        emit({ kind: "code_prompt", message });
        let code: string;
        try {
          code = normalizeRuntimeAuthCode(
            await interaction.prompt({ kind: "manual_code", message }),
          );
        } catch (error) {
          if (/empty/u.test((error as Error).message)) {
            message = "No code was entered. Paste the full code shown after signing in.";
            continue;
          }
          return fail((error as Error).message);
        }
        // Both halves of `code#state` are secrets: either one completes the sign-in.
        for (const secret of new Set([code, code.split("#")[0]!]))
          if (secret) options.onSecret?.(secret);
        codeSent = true;
        try {
          process.write(`${code}\n`);
        } catch (error) {
          fail((error as Error).message);
        }
        return;
      }
      if (!interactionFailed) fail("no code was entered");
    };

    const requestCode = (message: string) => {
      if (announcedUrl) {
        promptedForCode = true;
        void askForCode(message);
        return;
      }
      codePromptSeen = true;
      if (!authUrlWaitTimer) {
        authUrlWaitTimer = setTimeout(() => {
          authUrlWaitTimer = undefined;
          if (!announcedUrl && !interactionFailed) failMissingAuthUrl();
        }, CLAUDE_AUTH_URL_WAIT_MS);
      }
    };

    let promptedForCode = false;
    let invalidCodes = 0;
    const watch = async (
      stream: ReadableStream<Uint8Array>,
      inspect: (text: string) => void,
    ): Promise<void> => {
      const reader = stream.getReader();
      cancelReaders.push(() => reader.cancel().catch(() => undefined));
      const decoder = new TextDecoder();
      let raw = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        raw += decoder.decode(value, { stream: true });
        // Strip escapes from the whole buffer: one may be split across two chunks.
        inspect(raw.replace(ANSI, ""));
      }
    };
    const cancelReaders: Array<() => Promise<void>> = [];
    let announcedUrl = false;
    const reading = Promise.all([
      watch(process.stdout, (seen) => {
        if (!announcedUrl) {
          const url = AUTH_URL.exec(seen)?.[1];
          const trusted = url ? anthropicUrl(url) : undefined;
          if (trusted) {
            announcedUrl = true;
            if (authUrlWaitTimer) {
              clearTimeout(authUrlWaitTimer);
              authUrlWaitTimer = undefined;
            }
            emit({
              kind: "auth_url",
              verificationUrl: trusted,
              instructions: AUTH_URL_INSTRUCTIONS,
            });
          } else if (url) {
            untrustedLink = true;
            process.kill();
          }
        }
        // The prompt may print before the link, and may be only partly written so far.
        if (!promptedForCode && CODE_PROMPT.test(seen)) {
          requestCode("Paste the code shown after signing in.");
        }
        reportedSuccess ||= LOGIN_SUCCESSFUL.test(seen);
        loginFailure ??= LOGIN_FAILED.exec(seen)?.[1]?.trim();
      }),
      watch(process.stderr, (seen) => {
        const rejected = seen.match(INVALID_CODE_LINES)?.length ?? 0;
        if (rejected > invalidCodes) {
          invalidCodes = rejected;
          requestCode("That code was not accepted. Paste the full code shown after signing in.");
        }
        loginFailure ??= LOGIN_FAILED.exec(seen)?.[1]?.trim();
      }),
    ]).catch(() => undefined);

    try {
      const outcome = await settled.promise;
      if (outcome === "cancelled" || active.cancelled) return { status: "cancelled" };
      if (interactionFailed)
        return {
          status: "failed",
          reason: missingAuthUrl ? "process_failed" : "interaction_failed",
          detail: interactionFailed,
        };
      if (outcome === "timeout") return { status: "failed", reason: "timed_out" };
      await reading;
      if (untrustedLink)
        return {
          status: "failed",
          reason: "process_failed",
          detail: "Claude Code printed a sign-in link that is not an Anthropic address",
        };
      if (codePromptSeen && !announcedUrl)
        return { status: "failed", reason: "process_failed", detail: MISSING_AUTH_URL_DETAIL };
      // The CLI saying it succeeded, or exiting 0, is only a claim: `auth status` decides. A
      // success line with a bad exit code still counts once the account reads as signed in.
      if (exitCode !== 0 && !reportedSuccess)
        return {
          status: "failed",
          reason: codeSent ? "rejected" : "process_failed",
          detail: detail(loginFailure) ?? `claude exited with code ${exitCode ?? "unknown"}`,
        };
      const authStatus = await this.readStatus({ workingDirectory: options.workingDirectory });
      if (authStatus.state === "logged_in") return { status: "logged_in", authStatus };
      return {
        status: "failed",
        reason: codeSent ? "rejected" : "process_failed",
        detail: detail(loginFailure) ?? "Claude Code did not sign in",
      };
    } finally {
      clearTimeout(timer);
      if (authUrlWaitTimer) clearTimeout(authUrlWaitTimer);
      interaction.signal?.removeEventListener("abort", abort);
      await Promise.all(cancelReaders.map((cancel) => cancel()));
      if (this.#active === active) this.#active = undefined;
    }
  }

  async #versionBelowFloor(workingDirectory: string): Promise<boolean> {
    try {
      const { text } = await this.#run(["--version"], { workingDirectory });
      const parts = /(\d+)\.(\d+)\.(\d+)/u.exec(text)?.slice(1).map(Number);
      if (!parts) return false;
      const floor = CLAUDE_LOGIN_MINIMUM_VERSION.split(".").map(Number);
      for (let index = 0; index < 3; index += 1) {
        if (parts[index]! !== floor[index]!) return parts[index]! < floor[index]!;
      }
      return false;
    } catch {
      return false;
    }
  }

  async submitCode(): Promise<void> {
    throw new Error("The pasted code is returned through the login interaction");
  }

  async cancel(options: { operationId: string }): Promise<void> {
    if (this.#active?.id !== options.operationId) return;
    this.#active.cancelled = true;
    this.#active.process.kill();
  }

  async logout(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthLogoutResult> {
    try {
      const { exitCode } = await this.#run(["auth", "logout"], {
        workingDirectory: options.workingDirectory,
        timeoutMs: options.timeoutMs ?? CLAUDE_LOGOUT_TIMEOUT_MS,
      });
      if (exitCode !== 0)
        return {
          status: "failed",
          reason: "process_failed",
          detail: `claude exited with code ${exitCode}`,
        };
    } catch (error) {
      return notRunnable(error);
    }
    const authStatus = await this.readStatus({ workingDirectory: options.workingDirectory });
    return authStatus.state === "logged_in"
      ? { status: "failed", reason: "still_logged_in" }
      : { status: "logged_out", authStatus };
  }
}
