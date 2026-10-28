import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  normalizeRuntimeAuthCode,
  type RuntimeAuthAdapter,
  type RuntimeAuthLoginInteraction,
  type RuntimeAuthLoginResult,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthStatus,
} from "#src/contract";
import { runtimeAuthAccount } from "#src/runtime-auth-status";
import { withDeadline } from "#src/deadline";

export const DEVIN_AUTH_PROBE_TIMEOUT_MS = 20_000;
/** How long a printed URL may sit at the buffer's end before it is relayed as complete. */
const LOGIN_LINK_IDLE_FLUSH_MS = 250;
export const DEVIN_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 3;

/** Complete CSI and OSC sequences (an OSC 8 hyperlink wraps the sign-in link on a terminal); an
 * unfinished one at the end stays until the next read completes it. */
function withoutTerminalControls(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/gu, "");
}

/** A spawned `devin auth` process. Bytes are read, never logged. */
export interface DevinAuthProcess {
  readonly output: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(text: string): void;
  dispose(): Promise<void>;
}
export interface DevinAuthHost {
  /** `terminal` runs the CLI on a pseudo-terminal: its paste-code prompt reads only a TTY. */
  spawn(args: readonly string[], cwd: string, terminal?: boolean): DevinAuthProcess;
  /** POSIX hosts can give the CLI a terminal; elsewhere login falls back to Devin's browser flow. */
  readonly terminalLoginSupported: boolean;
}

/**
 * `devin auth status` prints a human report; only the login state and the plan are read from it.
 * The report also names the person, their email and the credentials file, none of which is kept.
 */
function readDevinAuthStatus(output: string, exitCode: number): RuntimeAuthStatus {
  const loggedOut: RuntimeAuthStatus = {
    provider: RUNTIME_PROVIDER.DEVIN,
    state: "logged_out",
  };
  if (/\bnot logged in\b|\blogged out\b|\bnot authenticated\b/i.test(output)) return loggedOut;
  if (exitCode !== 0 || !/\blogged in\b/i.test(output))
    return { provider: RUNTIME_PROVIDER.DEVIN, state: "unknown" };
  const field = (name: string) =>
    new RegExp(`^\\s*${name}:\\s*(.+)$`, "im").exec(output)?.[1]?.trim();
  return {
    provider: RUNTIME_PROVIDER.DEVIN,
    state: "logged_in",
    ...runtimeAuthAccount({
      planLabel: field("Plan") ?? field("Tier"),
      methodLabel: "Devin",
    }),
  };
}

/** Native Devin login/logout through its own CLI; the browser flow belongs to the CLI. */
export class DevinRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.DEVIN;
  #active?: { abort: AbortController; done: Promise<RuntimeAuthLoginResult> };
  constructor(private readonly host: DevinAuthHost) {}

  async #read(cwd: string, timeoutMs = DEVIN_AUTH_PROBE_TIMEOUT_MS): Promise<RuntimeAuthStatus> {
    const child = this.host.spawn(["auth", "status"], cwd);
    try {
      const [text, code] = await withDeadline(
        Promise.all([new Response(child.output).text(), child.exited]),
        timeoutMs,
        () => new Error("Devin auth status timed out"),
      );
      return readDevinAuthStatus(text, code);
    } finally {
      await child.dispose();
    }
  }

  async readStatus(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthStatus> {
    try {
      return await this.#read(options.workingDirectory, options.timeoutMs);
    } catch (error) {
      return {
        provider: this.provider,
        state:
          (error as { code?: string }).code === "runtime_not_found" ? "unavailable" : "unknown",
        ...((error as { code?: string }).code === "runtime_not_found"
          ? { unavailableReason: "not_installed" as const }
          : {}),
      };
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
    const done = this.#login(options, interaction, abort.signal).finally(() => {
      interaction.signal?.removeEventListener("abort", cancel);
      this.#active = undefined;
    });
    this.#active = { abort, done };
    return done;
  }

  async #login(
    options: Parameters<RuntimeAuthAdapter["startLogin"]>[0],
    interaction: RuntimeAuthLoginInteraction,
    signal: AbortSignal,
  ): Promise<RuntimeAuthLoginResult> {
    let child: DevinAuthProcess | undefined;
    let work: Promise<RuntimeAuthLoginResult> | undefined;
    let deadline = false;
    let stop: () => void = () => {};
    try {
      if (signal.aborted) return { status: "cancelled" };
      // The manual-token flow hands the person a link and takes the code back through the Web, so
      // it works whether or not they sit at this Computer; the browser flow's localhost redirect
      // only works on the Computer itself.
      const terminal = this.host.terminalLoginSupported;
      child = this.host.spawn(
        terminal ? ["auth", "login", "--force-manual-token-flow"] : ["auth", "login"],
        options.workingDirectory,
        terminal,
      );
      const process = child;
      const abort = new Promise<never>((_, reject) => {
        stop = () => reject(new Error("login cancelled"));
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      });
      work = (async () => {
        const decoder = new TextDecoder();
        const links = new Set<string>();
        // Every distinct link the CLI prints is relayed once, in order (a help link may precede
        // the sign-in link). A match that reaches the end of the buffer may still be growing in
        // the next read, so it waits; a short idle flush relays it when the CLI has stopped
        // writing (it may print the link without a newline and then wait for the browser).
        const relay = (link: string) => {
          if (links.has(link)) return;
          links.add(link);
          interaction.onEvent({ kind: "auth_url", verificationUrl: link });
        };
        let pending = "";
        // A bounded window of recent output, only for spotting the code prompt.
        let recent = "";
        let codeTask: Promise<void> | undefined;
        let codeFailure = false;
        let codeSent = false;
        const consume = (flushTail: boolean) => {
          pending = withoutTerminalControls(pending);
          let consumed = 0;
          for (const match of pending.matchAll(/https:\/\/[^\s"'<>\x07\x1b]+/g)) {
            const end = (match.index ?? 0) + match[0].length;
            if (!flushTail && end === pending.length) break;
            relay(match[0]);
            consumed = end;
          }
          recent = (recent + pending.slice(0, consumed)).slice(-512);
          pending = pending.slice(consumed);
          // Bound what a chatty CLI can retain; the tail keeps a partial URL joinable.
          if (pending.length > 8192) pending = pending.slice(-1024);
          if (codeTask || !/paste it below/i.test(recent + pending)) return;
          codeTask = (async () => {
            let message = "Paste the code Devin shows after signing in.";
            for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
              let code: string;
              try {
                code = normalizeRuntimeAuthCode(
                  await interaction.prompt({ kind: "manual_code", message }),
                );
              } catch (error) {
                if (/empty/u.test((error as Error).message) && !signal.aborted) {
                  message = "No code was entered. Paste the full code shown after signing in.";
                  continue;
                }
                break;
              }
              options.onSecret?.(code);
              codeSent = true;
              process.write(`${code}\r`);
              return;
            }
            codeFailure = true;
            await process.dispose();
          })();
        };
        let idle: ReturnType<typeof setTimeout> | undefined;
        try {
          for await (const chunk of process.output) {
            if (idle !== undefined) clearTimeout(idle);
            pending += decoder.decode(chunk, { stream: true });
            consume(false);
            idle = setTimeout(() => {
              idle = undefined;
              consume(true);
            }, LOGIN_LINK_IDLE_FLUSH_MS);
          }
        } finally {
          if (idle !== undefined) clearTimeout(idle);
        }
        pending += decoder.decode();
        consume(true);
        const exitCode = await process.exited;
        // A CLI that exits while the person is still asked for a code is not waited on.
        if (codeFailure) return { status: "failed", reason: "interaction_failed" };
        if (exitCode !== 0)
          return {
            status: "failed",
            // The CLI exits non-zero when Devin refuses the pasted code.
            reason: codeSent ? "rejected" : "process_failed",
          };
        if (signal.aborted) return { status: "cancelled" };
        const status = await this.#read(
          options.workingDirectory,
          DEVIN_AUTH_PROBE_TIMEOUT_MS,
        ).catch(() => undefined);
        return status?.state === "logged_in"
          ? { status: "logged_in", authStatus: status }
          : { status: "failed", reason: "not_logged_in" };
      })();
      return await withDeadline(
        Promise.race([work, abort]),
        options.timeoutMs ?? DEVIN_LOGIN_TIMEOUT_MS,
        () => {
          deadline = true;
          this.#active?.abort.abort();
          return new Error("Devin login timed out");
        },
      );
    } catch (error) {
      if (deadline) return { status: "failed", reason: "timed_out" };
      if (signal.aborted) return { status: "cancelled" };
      if ((error as { code?: string }).code === "runtime_not_found")
        return { status: "unsupported", reason: "not_installed" };
      return { status: "failed", reason: "interaction_failed" };
    } finally {
      signal.removeEventListener("abort", stop);
      await child?.dispose();
      await work?.catch(() => {});
    }
  }

  /** The code reaches the CLI through `interaction.prompt`; there is no second entry point. */
  async submitCode(): Promise<void> {
    throw new Error("Devin login takes its code through the login interaction");
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
    await this.cancel();
    let child: DevinAuthProcess | undefined;
    try {
      child = this.host.spawn(["auth", "logout"], options.workingDirectory);
      const [, code] = await withDeadline(
        Promise.all([new Response(child.output).text(), child.exited]),
        options.timeoutMs ?? DEVIN_AUTH_PROBE_TIMEOUT_MS,
        () => new Error("Devin logout timed out"),
      );
      if (code !== 0) return { status: "failed", reason: "process_failed" };
      const authStatus = await this.readStatus(options);
      return authStatus.state === "logged_out"
        ? { status: "logged_out", authStatus }
        : {
            status: "failed",
            reason: authStatus.state === "logged_in" ? "still_logged_in" : "process_failed",
          };
    } catch {
      return { status: "failed", reason: "process_failed" };
    } finally {
      await child?.dispose();
    }
  }
}
