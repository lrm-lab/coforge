import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import { parseKiroIdentityCenterOptions } from "@lrm/coforge-sdk/internal";
import {
  type RuntimeAuthAdapter,
  type RuntimeAuthLoginInteraction,
  type RuntimeAuthLoginResult,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthStatus,
} from "#src/contract";
import { runtimeAuthAccount } from "#src/runtime-auth-status";
import { withDeadline } from "#src/deadline";
import { KiroAuthFailure, KiroEnterpriseLoginTranscript } from "./auth-transcript";
import { parseKiroWhoami } from "./whoami";

export const KIRO_LOGIN_TIMEOUT_MS = 16 * 60 * 1000;
export const KIRO_AUTH_PROBE_TIMEOUT_MS = 20_000;
export interface KiroAuthProcess {
  readonly output: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(text: string): void;
  dispose(): Promise<void>;
}
export interface KiroAuthHost {
  readonly enterpriseLoginSupported: boolean;
  spawn(args: readonly string[], cwd: string, terminal: boolean): KiroAuthProcess;
  maskAccountLabel(value: string): string | undefined;
}

/** Native Kiro login policy; all processes, environments and account masking come from the host. */
export class KiroRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.KIRO;
  #active?: { abort: AbortController; done: Promise<RuntimeAuthLoginResult> };
  constructor(private readonly host: KiroAuthHost) {}
  async #read(
    cwd: string,
    timeoutMs = KIRO_AUTH_PROBE_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<{ data?: Record<string, unknown>; status: RuntimeAuthStatus }> {
    if (signal?.aborted) throw new KiroAuthFailure("interaction_failed");
    const child = this.host.spawn(["whoami", "--format", "json"], cwd, false);
    const stopped = Promise.withResolvers<never>();
    const abort = () => stopped.reject(new KiroAuthFailure("interaction_failed"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const [text] = await withDeadline(
        Promise.race([
          Promise.all([new Response(child.output).text(), child.exited]),
          stopped.promise,
        ]),
        timeoutMs,
        () => new KiroAuthFailure("timed_out"),
      );
      const parsed = parseKiroWhoami(text);
      const data = parsed.data;
      if (parsed.state === "logged_out")
        return { status: { provider: this.provider, state: "logged_out" } };
      if (parsed.state !== "logged_in" || !data)
        return { status: { provider: this.provider, state: "unknown" } };
      return {
        data,
        status: {
          provider: this.provider,
          state: "logged_in",
          ...runtimeAuthAccount({
            maskedLabel:
              typeof data.email === "string" ? this.host.maskAccountLabel(data.email) : undefined,
            methodLabel:
              data.accountType === "IamIdentityCenter" ? "IAM Identity Center" : data.accountType,
          }),
        },
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      await child.dispose();
    }
  }
  async readStatus(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthStatus> {
    try {
      return (await this.#read(options.workingDirectory, options.timeoutMs)).status;
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
    if (!this.host.enterpriseLoginSupported)
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
    this.#active = { abort, done };
    return done;
  }
  async #login(
    options: Parameters<RuntimeAuthAdapter["startLogin"]>[0],
    interaction: RuntimeAuthLoginInteraction,
    signal: AbortSignal,
  ): Promise<RuntimeAuthLoginResult> {
    let child: KiroAuthProcess | undefined;
    let work: Promise<RuntimeAuthLoginResult> | undefined;
    let deadline = false;
    let stop: () => void = () => {};
    try {
      const target = parseKiroIdentityCenterOptions(options.kiroIdentityCenter);
      if (signal.aborted) return { status: "cancelled" };
      child = this.host.spawn(
        [
          "login",
          "--license",
          "pro",
          "--identity-provider",
          target.startUrl,
          "--region",
          target.region,
          "--use-device-flow",
        ],
        options.workingDirectory,
        true,
      );
      const process = child;
      const transcript = new KiroEnterpriseLoginTranscript(
        target,
        (t) => process.write(t),
        interaction.onEvent,
        options.onSecret,
      );
      const abort = new Promise<never>((_, reject) => {
        stop = () => reject(new KiroAuthFailure("interaction_failed"));
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      });
      work = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of process.output)
          transcript.accept(decoder.decode(chunk, { stream: true }));
        transcript.accept(decoder.decode());
        if ((await process.exited) !== 0) throw new KiroAuthFailure("process_failed");
        const result = await this.#read(
          options.workingDirectory,
          KIRO_AUTH_PROBE_TIMEOUT_MS,
          signal,
        );
        if (
          result.data?.accountType !== "IamIdentityCenter" ||
          result.data.startUrl !== target.startUrl ||
          result.data.region !== target.region
        )
          return { status: "failed", reason: "not_logged_in" } as const;
        return { status: "logged_in", authStatus: result.status } as const;
      })();
      return await withDeadline(
        Promise.race([work, abort]),
        options.timeoutMs ?? KIRO_LOGIN_TIMEOUT_MS,
        () => {
          deadline = true;
          this.#active?.abort.abort();
          return new KiroAuthFailure("timed_out");
        },
      );
    } catch (error) {
      if (deadline) return { status: "failed", reason: "timed_out" };
      if (signal.aborted) return { status: "cancelled" };
      if ((error as { code?: string }).code === "runtime_not_found")
        return { status: "unsupported", reason: "not_installed" };
      if (error instanceof KiroAuthFailure)
        return {
          status: "failed",
          reason: error.reason,
          ...(error.detail ? { detail: error.detail } : {}),
        };
      return { status: "failed", reason: "interaction_failed" };
    } finally {
      signal.removeEventListener("abort", stop);
      await child?.dispose();
      await work?.catch(() => {});
    }
  }
  async submitCode(): Promise<void> {
    throw new Error("Kiro device codes are entered in the provider browser");
  }
  async cancel(): Promise<void> {
    await this.dispose();
  }
  async dispose(): Promise<void> {
    const active = this.#active;
    active?.abort.abort();
    await active?.done;
  }
  async logout(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthLogoutResult> {
    await this.dispose();
    let child: KiroAuthProcess | undefined;
    try {
      child = this.host.spawn(["logout"], options.workingDirectory, false);
      const [, code] = await withDeadline(
        Promise.all([new Response(child.output).text(), child.exited]),
        options.timeoutMs ?? KIRO_AUTH_PROBE_TIMEOUT_MS,
        () => new KiroAuthFailure("timed_out"),
      );
      if (code !== 0) return { status: "failed", reason: "process_failed" };
      const authStatus = await this.readStatus(options);
      return authStatus.state === "logged_out"
        ? { status: "logged_out", authStatus }
        : {
            status: "failed",
            reason: authStatus.state === "logged_in" ? "still_logged_in" : "process_failed",
          };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof KiroAuthFailure ? "timed_out" : "process_failed",
      };
    } finally {
      await child?.dispose();
    }
  }
}
