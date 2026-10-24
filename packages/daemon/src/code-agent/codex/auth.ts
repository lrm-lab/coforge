import type {
  RuntimeAuthAdapter,
  RuntimeAuthLoginEvent,
  RuntimeAuthLoginResult,
  RuntimeAuthLogoutResult,
  RuntimeAuthStatus,
} from "@lrm/coforge-anvil";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { JsonlProcess } from "#src/code-agent/jsonl-process";
import { agentEnvironment } from "#src/code-agent/environment";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { asRecord } from "#src/code-agent/json-record";

export const CODEX_LOGIN_MINIMUM_VERSION = "0.118.0";
export const CODEX_LOGIN_TIMEOUT_MS = 16 * 60 * 1_000;
export const CODEX_LOGIN_STATUS_TIMEOUT_MS = 20_000;

type RecordValue = Readonly<Record<string, unknown>>;
export interface CodexAppServerProcess {
  readonly exitCode?: number;
  request(command: RecordValue): Promise<RecordValue>;
  send(message: RecordValue): Promise<void>;
  onRecord(listener: (record: RecordValue) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  dispose(): Promise<void>;
}
export type CodexAppServerFactory = (cwd: string) => CodexAppServerProcess;

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function versionAtLeast(version: string | undefined): boolean {
  if (!version) return true;
  const parse = (value: string) =>
    value
      .match(/(\d+)\.(\d+)\.(\d+)/u)
      ?.slice(1)
      .map(Number);
  const actual = parse(version);
  const minimum = parse(CODEX_LOGIN_MINIMUM_VERSION);
  if (!actual || !minimum) return false;
  const [major = 0, minor = 0, patch = 0] = actual;
  const [minimumMajor = 0, minimumMinor = 0, minimumPatch = 0] = minimum;
  return (
    major > minimumMajor ||
    (major === minimumMajor &&
      (minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)))
  );
}

function detail(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

export class CodexRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.CODEX;
  readonly #command: readonly string[];
  readonly #version: string | undefined;
  readonly #create: CodexAppServerFactory;
  readonly #accountReadTimeoutMs: number;
  #active?: { id: string; process: CodexAppServerProcess; cancelled: boolean };

  constructor(
    options: {
      command?: readonly string[];
      version?: string;
      create?: CodexAppServerFactory;
      accountReadTimeoutMs?: number;
    } = {},
  ) {
    this.#command = options.command ?? [RUNTIME_PROVIDER.CODEX, "app-server"];
    this.#version = options.version;
    this.#accountReadTimeoutMs = options.accountReadTimeoutMs ?? 20_000;
    this.#create =
      options.create ??
      ((cwd) =>
        new JsonlProcess(
          this.#command,
          cwd,
          agentEnvironment(undefined, Bun.env, undefined, {
            envVars: undefined,
            extraEnv: { NO_COLOR: "1" },
          }),
        ));
  }

  get activeOperationId(): string | undefined {
    return this.#active?.id;
  }

  async readStatus(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthStatus> {
    const command = [this.#command[0]!, "login", "status"];
    const child = Bun.spawn({
      cmd: command,
      cwd: options.workingDirectory,
      env: environment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]).then(([text, exitCode]) => ({
        text,
        exitCode,
      })),
      new Promise<{ text: string; exitCode: number }>((resolve) =>
        setTimeout(() => {
          child.kill();
          resolve({ text: "", exitCode: -1 });
        }, options.timeoutMs ?? CODEX_LOGIN_STATUS_TIMEOUT_MS),
      ),
    ]);
    const text = output.text.trim();
    if (output.exitCode === 0) {
      const method = text.match(/Logged in using (ChatGPT|an API key)/iu)?.[1];
      return {
        provider: RUNTIME_PROVIDER.CODEX,
        state: method ? "logged_in" : "unknown",
        ...(method ? { loginMethod: method } : {}),
      };
    }
    if (output.exitCode === 1 && /^Not logged in/iu.test(text))
      return { provider: RUNTIME_PROVIDER.CODEX, state: "logged_out" };
    return {
      provider: RUNTIME_PROVIDER.CODEX,
      state: "unknown",
      ...(text ? { unavailableReason: undefined } : {}),
    };
  }

  async startLogin(
    options: { workingDirectory: string; timeoutMs?: number },
    interaction: {
      onEvent(event: RuntimeAuthLoginEvent): void;
      prompt(input: { kind: "manual_code"; message?: string }): Promise<string>;
      signal?: AbortSignal;
    },
  ): Promise<RuntimeAuthLoginResult> {
    if (this.#active) return { status: "failed", reason: "rejected" };
    if (!versionAtLeast(this.#version))
      return {
        status: "failed",
        reason: "process_failed",
        detail: `Codex ${CODEX_LOGIN_MINIMUM_VERSION} or newer is required`,
      };
    const id = crypto.randomUUID();
    const process = this.#create(options.workingDirectory);
    this.#active = { id, process, cancelled: false };
    let loginId: string | undefined;
    const earlyCompletions: RecordValue[] = [];
    let interactionFailed = false;
    let cancelledBySignal = false;
    let resolveCompletion!: (record: RecordValue) => void;
    const completion = new Promise<RecordValue>((resolve) => {
      resolveCompletion = resolve;
    });
    const offRecord = process.onRecord((record) => {
      if (record.method !== "account/login/completed") return;
      const params = asRecord(record.params) ?? {};
      if (!loginId || params.loginId === loginId) {
        if (loginId) resolveCompletion(record);
        else earlyCompletions.push(record);
      }
    });
    const offFailure = process.onFailure(() =>
      resolveCompletion({ __processFailure: true, exitCode: process.exitCode }),
    );
    const abort = () => {
      cancelledBySignal = true;
      resolveCompletion({ __cancelled: true });
      process.dispose().catch(() => undefined);
    };
    interaction.signal?.addEventListener("abort", abort, { once: true });
    try {
      await process.request({
        method: "initialize",
        params: {
          clientInfo: {
            name: "coforge_daemon",
            title: "CoForge Daemon",
            version: COFORGE_DAEMON_VERSION,
          },
          capabilities: { experimentalApi: true },
        },
      });
      await process.send({ method: "initialized", params: {} });
      const response = await process.request({
        method: "account/login/start",
        params: { type: "chatgptDeviceCode" },
      });
      const result = asRecord(response.result);
      loginId = typeof result?.loginId === "string" ? result.loginId : undefined;
      const verificationUrl =
        typeof result?.verificationUrl === "string" ? result.verificationUrl : undefined;
      const userCode = typeof result?.userCode === "string" ? result.userCode : undefined;
      if (!loginId || !verificationUrl || !userCode)
        return {
          status: "failed",
          reason: "process_failed",
          detail: "Codex returned an invalid device-code response",
        };
      const earlyCompletion = earlyCompletions.find(
        (record) => asRecord(record.params)?.loginId === loginId,
      );
      if (earlyCompletion) {
        resolveCompletion(earlyCompletion);
      } else {
        try {
          interaction.onEvent({
            kind: "device_code",
            verificationUrl,
            userCode,
            expiresAtMs: Date.now() + CODEX_LOGIN_TIMEOUT_MS,
          });
          interaction.onEvent({
            kind: "info",
            message:
              "Device code sign-in must be allowed in your ChatGPT security settings (for a workspace account, by its admin).",
          });
        } catch (error) {
          interactionFailed = true;
          return {
            status: "failed",
            reason: "interaction_failed",
            detail: detail(error instanceof Error ? error.message : error),
          };
        }
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        completion,
        new Promise<RecordValue>((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve({ __timeout: true }),
            options.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS,
          );
        }),
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (this.#active?.cancelled || cancelledBySignal) return { status: "cancelled" };
      if (completed.__cancelled) return { status: "cancelled" };
      if (completed.__timeout) return { status: "failed", reason: "timed_out" };
      if (completed.__processFailure)
        return {
          status: "failed",
          reason: "process_failed",
          detail: `${RUNTIME_PROVIDER.CODEX} app-server exited with code ${String(completed.exitCode ?? process.exitCode ?? "unknown")}`,
        };
      const params = asRecord(completed.params) ?? {};
      if (params.success !== true)
        return { status: "failed", reason: "rejected", detail: detail(params.error) };
      let account: unknown;
      try {
        account = asRecord(
          (
            await withTimeout(
              process.request({ method: "account/read", params: {} }),
              this.#accountReadTimeoutMs,
            )
          ).result,
        )?.account;
      } catch {
        account = undefined;
      }
      const accountRecord = asRecord(account);
      return {
        status: "logged_in",
        authStatus: {
          provider: RUNTIME_PROVIDER.CODEX,
          state: "logged_in",
          ...(typeof accountRecord?.email === "string"
            ? { accountLabel: accountRecord.email }
            : {}),
          ...(typeof accountRecord?.planType === "string" ? { plan: accountRecord.planType } : {}),
          ...(typeof accountRecord?.type === "string" ? { loginMethod: accountRecord.type } : {}),
        },
      };
    } catch (error) {
      if (cancelledBySignal || this.#active?.cancelled) return { status: "cancelled" };
      return {
        status: "failed",
        reason: interactionFailed
          ? "interaction_failed"
          : process.exitCode !== undefined
            ? "process_failed"
            : "rejected",
        detail:
          process.exitCode !== undefined
            ? `${RUNTIME_PROVIDER.CODEX} app-server exited with code ${process.exitCode}`
            : detail(error instanceof Error ? error.message : error),
      };
    } finally {
      offRecord();
      offFailure();
      interaction.signal?.removeEventListener("abort", abort);
      await process.dispose().catch(() => undefined);
      if (this.#active?.id === id) this.#active = undefined;
    }
  }

  async submitCode(): Promise<void> {
    throw new Error("Codex device-code login does not accept a pasted code");
  }
  async cancel(options: { operationId: string }): Promise<void> {
    if (this.#active?.id === options.operationId) {
      this.#active.cancelled = true;
      await this.#active.process.dispose().catch(() => undefined);
    }
  }
  async logout(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthLogoutResult> {
    void options;
    return {
      status: "failed",
      reason: "process_failed",
      detail: "Codex logout is not implemented",
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error("request timed out")), timeoutMs);
    }),
  ]);
  if (handle) clearTimeout(handle);
  return result;
}
