import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { acpBounded, acpProcess } from "#src/acp/connection";
import type { ProcessTreeSpawner } from "#src/process-tree";
import { withDeadline } from "#src/deadline";
import {
  type RuntimeAuthAdapter,
  type RuntimeAuthLoginInteraction,
  type RuntimeAuthLoginResult,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthStatus,
} from "#src/contract";
import { runtimeAuthAccount } from "#src/runtime-auth-status";
import { DROID_ACP_PROFILE } from "./acp-session";

/** A status read runs `droid doctor --checks auth`, which loads the credential store. */
export const DROID_AUTH_PROBE_TIMEOUT_MS = 20_000;
/** How long the interactive login may take to print its device code before the fallback text. */
export const DROID_LOGIN_CODE_TIMEOUT_MS = 60_000;
/** How long a person has to finish the sign-in in the browser once the code is shown. */
export const DROID_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How often the login polls its own status while the browser flow runs. */
export const DROID_LOGIN_POLL_INTERVAL_MS = 2_000;
/** The page droid's device flow always names (1.4.1; the code is the only variable part). */
export const DROID_DEVICE_URL = "https://auth.factory.ai/device";

/** How much of the login's raw output is kept for the no-code fallback log. */
const LOGIN_OUTPUT_LIMIT = 64_000;
/** A device code droid prints as `SMBZ-WNMD`. */
const DEVICE_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/** The byte-stream view a native CLI auth adapter reads, as Kiro's host supplies it. */
export interface DroidAuthProcess {
  readonly output: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(text: string): void;
  dispose(): Promise<void>;
}

/** Everything Droid's auth adapter needs from the daemon: processes, the resolved executable,
 * the environment it launches with, and the only form an account label may leave in. */
export interface DroidAuthHost {
  /** The executable the host resolved for this runtime — never `droid` from PATH. */
  readonly command: readonly string[];
  /** The launch environment for the interactive login and the status probe. */
  readonly environment: Readonly<Record<string, string>>;
  /** Process ownership: ACP logout uses the shared transport, the TUI login its own spawn. */
  readonly processTreeSpawner: ProcessTreeSpawner;
  readonly clientInfo: Readonly<{ name: string; version: string }>;
  /** Whether this Computer can host the interactive TUI (a PTY login is verified on macOS and Linux). */
  readonly interactiveLoginSupported: boolean;
  /** `FACTORY_API_KEY` in the launch environment: droid uses it instead of a stored login, and
   * no logout can take it away. */
  readonly factoryApiKeyConfigured: boolean;
  /** Spawns one auth process; `terminal` allocates the PTY the interactive login needs. */
  spawn(args: readonly string[], cwd: string, terminal: boolean): DroidAuthProcess;
  maskAccountLabel(value: string): string | undefined;
  /** The login output that never produced a code, for the daemon log (already redacted there). */
  logUnmatchedLoginOutput(text: string): void;
}

export interface DroidAuthAdapterOptions {
  readonly host: DroidAuthHost;
  /** Tests lower these; production uses the exported defaults. */
  readonly codeTimeoutMs?: number;
  readonly loginTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

type DoctorResult = Readonly<{ id?: string; status?: string; detail?: string }>;

/**
 * Factory Droid's own auth surface. Status comes from `droid doctor --json --checks auth` (the
 * credential store's verdict, not a guess); sign-in is the interactive TUI in a PTY, because the
 * CLI has no non-interactive login command, and the device flow prints
 * `https://auth.factory.ai/device` plus a `XXXX-XXXX` code; sign-out is the server's own ACP
 * `logout`, which clears the stored Factory session but cannot touch `FACTORY_API_KEY`.
 */
export class DroidRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.DROID;
  #active: Promise<RuntimeAuthLoginResult> | undefined;
  readonly #host: DroidAuthHost;
  readonly #codeTimeoutMs: number;
  readonly #loginTimeoutMs: number;
  readonly #pollIntervalMs: number;
  constructor(options: DroidAuthAdapterOptions) {
    this.#host = options.host;
    this.#codeTimeoutMs = options.codeTimeoutMs ?? DROID_LOGIN_CODE_TIMEOUT_MS;
    this.#loginTimeoutMs = options.loginTimeoutMs ?? DROID_LOGIN_TIMEOUT_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DROID_LOGIN_POLL_INTERVAL_MS;
  }

  async readStatus(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthStatus> {
    try {
      const results = await this.#doctor(
        options.workingDirectory,
        options.timeoutMs ?? DROID_AUTH_PROBE_TIMEOUT_MS,
      );
      return this.#statusFromDoctor(results);
    } catch (error) {
      const notInstalled = (error as { code?: string }).code === "runtime_not_found";
      return {
        provider: this.provider,
        state: notInstalled ? "unavailable" : "unknown",
        ...(notInstalled ? { unavailableReason: "not_installed" as const } : {}),
      };
    }
  }

  startLogin(
    options: Parameters<RuntimeAuthAdapter["startLogin"]>[0],
    interaction: RuntimeAuthLoginInteraction,
  ): Promise<RuntimeAuthLoginResult> {
    if (!this.#host.interactiveLoginSupported)
      return Promise.resolve({ status: "unsupported", reason: "unsupported_installation" });
    if (this.#active) return Promise.resolve({ status: "busy" });
    const abort = new AbortController();
    const cancel = () => abort.abort();
    interaction.signal?.addEventListener("abort", cancel, { once: true });
    if (interaction.signal?.aborted) abort.abort();
    const done = this.#login(options, interaction, abort.signal).finally(() => {
      interaction.signal?.removeEventListener("abort", cancel);
      this.#active = undefined;
    });
    this.#active = done;
    return done;
  }

  async submitCode(): Promise<void> {
    // The device flow is completed in the browser — nothing is pasted back to this process.
  }

  async logout(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthLogoutResult> {
    if (this.#host.factoryApiKeyConfigured)
      return {
        status: "failed",
        reason: "still_logged_in",
        detail:
          "FACTORY_API_KEY is set for this Computer; remove it from the runtime configuration to sign out.",
      };
    const timeoutMs = options.timeoutMs ?? DROID_AUTH_PROBE_TIMEOUT_MS;
    const transport = acpProcess(DROID_ACP_PROFILE, {
      command: this.#host.command,
      cwd: options.workingDirectory,
      environment: this.#host.environment,
      clientInfo: this.#host.clientInfo,
      processTreeSpawner: this.#host.processTreeSpawner,
    });
    try {
      await transport.initialize(timeoutMs);
      await acpBounded(
        transport.connection.agent.request("logout", {}),
        timeoutMs,
        "droid acp logout timed out",
      );
      const authStatus = await this.readStatus({
        workingDirectory: options.workingDirectory,
        timeoutMs,
      });
      if (authStatus.state === "logged_in") return { status: "failed", reason: "still_logged_in" };
      return { status: "logged_out", authStatus };
    } catch (error) {
      return {
        status: "failed",
        reason:
          error instanceof Error && /timed out/i.test(error.message)
            ? "timed_out"
            : "process_failed",
        detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
      };
    } finally {
      await transport.dispose().catch(() => undefined);
    }
  }

  async #doctor(cwd: string, timeoutMs: number): Promise<readonly DoctorResult[]> {
    const child = this.#host.spawn(["doctor", "--json", "--checks", "auth"], cwd, false);
    try {
      const text = await withDeadline(
        Promise.all([new Response(child.output).text(), child.exited]).then(([output]) => output),
        timeoutMs,
        () => new Error("droid doctor timed out"),
      );
      // The report is one JSON object; a wrapper's own progress line (if any) is not part of it.
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const parsed = JSON.parse(start === -1 ? text : text.slice(start, end + 1)) as {
        results?: unknown;
      };
      if (!Array.isArray(parsed.results)) throw new Error("droid doctor returned no results");
      return parsed.results as DoctorResult[];
    } finally {
      await child.dispose();
    }
  }

  #statusFromDoctor(results: readonly DoctorResult[]): RuntimeAuthStatus {
    const verify = results.find((entry) => entry.id === "auth.verify");
    const credentials = results.find((entry) => entry.id === "auth.credentials");
    const detail = verify?.detail ?? "";
    const apiKey = /FACTORY_API_KEY/.test(credentials?.detail ?? "");
    if (apiKey)
      return {
        provider: this.provider,
        state: "logged_in",
        ...runtimeAuthAccount({ methodLabel: "Factory API key" }),
      };
    if (verify?.status === "pass") {
      const email = /authenticated as (\S+)/i.exec(detail)?.[1];
      return {
        provider: this.provider,
        state: "logged_in",
        ...runtimeAuthAccount({
          maskedLabel: email ? this.#host.maskAccountLabel(email) : undefined,
          methodLabel: "Factory account",
        }),
      };
    }
    if (/no usable credentials|not logged in/i.test(detail))
      return { provider: this.provider, state: "logged_out" };
    return { provider: this.provider, state: "unknown" };
  }

  async #login(
    options: Parameters<RuntimeAuthAdapter["startLogin"]>[0],
    interaction: RuntimeAuthLoginInteraction,
    signal: AbortSignal,
  ): Promise<RuntimeAuthLoginResult> {
    const child = this.#host.spawn([], options.workingDirectory, true);
    const aborted = Promise.withResolvers<never>();
    aborted.promise.catch(() => undefined);
    const abort = () => aborted.reject(new Error("droid login cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let raw = "";
    const code = Promise.withResolvers<string>();
    let settledCode = false;
    void (async () => {
      const reader = child.output.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw = (raw + decoder.decode(value, { stream: true })).slice(-LOGIN_OUTPUT_LIMIT);
          if (settledCode) continue;
          const match = DEVICE_CODE.exec(stripAnsi(raw));
          if (match) {
            settledCode = true;
            code.resolve(match[1]!);
          }
        }
      } catch {
        // A disposed process ends its output; the wait below reports the outcome.
      } finally {
        reader.releaseLock();
      }
    })();
    // The first screen is a menu with Login selected; the command reaches the same flow.
    const enterLogin = setTimeout(() => {
      if (!settledCode) child.write("/login\r");
    }, 1_500);
    try {
      const userCode = await withDeadline(
        Promise.race([code.promise, aborted.promise, child.exited.then(() => undefined)]),
        this.#codeTimeoutMs,
        () => new Error("droid did not print a device code"),
      ).catch((error: unknown) => {
        this.#host.logUnmatchedLoginOutput(raw);
        throw error;
      });
      if (signal.aborted) return { status: "cancelled" };
      if (!userCode)
        return {
          status: "failed",
          reason: "process_failed",
          detail: "droid exited before its device code appeared.",
        };
      interaction.onEvent({
        kind: "device_code",
        verificationUrl: DROID_DEVICE_URL,
        userCode,
      });
      const deadline = Date.now() + (options.timeoutMs ?? this.#loginTimeoutMs);
      while (Date.now() < deadline) {
        if (signal.aborted) return { status: "cancelled" };
        const authStatus = await this.readStatus({
          workingDirectory: options.workingDirectory,
        }).catch(() => undefined);
        if (authStatus?.state === "logged_in") return { status: "logged_in", authStatus };
        await withDeadline(
          Promise.race([Bun.sleep(this.#pollIntervalMs), aborted.promise]),
          this.#pollIntervalMs + 1_000,
          () => new Error("droid login wait cancelled"),
        ).catch(() => undefined);
      }
      return {
        status: "failed",
        reason: "timed_out",
        detail: "The browser sign-in did not complete in time.",
      };
    } catch {
      return signal.aborted
        ? { status: "cancelled" }
        : {
            status: "failed",
            reason: "interaction_failed",
            detail: "droid_code_unavailable",
          };
    } finally {
      clearTimeout(enterLogin);
      signal.removeEventListener("abort", abort);
      await child.dispose().catch(() => undefined);
    }
  }
}

/** Drops ANSI escapes so the printed sentence and its code read as one line. */
function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/[\r\n]+/g, " ");
}
