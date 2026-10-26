import { getLogger } from "@logtape/logtape";
import {
  normalizeRuntimeAuthCode,
  sanitizeRuntimeAuthStatus,
  type RuntimeAuthAdapter,
  type RuntimeAuthLoginEvent,
  type RuntimeAuthLoginResult,
  type RuntimeAuthProvider,
} from "@lrm/coforge-anvil";
import { encodeRuntimeAuthLoginReport } from "@lrm/coforge-sdk/internal";
import type {
  KiroIdentityCenterOptions,
  RuntimeAuthIntent,
  RuntimeAuthLoginReport,
  RuntimeAuthLoginResult as LoginResult,
  RuntimeAuthLogoutReport,
  RuntimeAuthLogoutResult as LogoutResult,
  RuntimeAuthScope,
} from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-auth"]);
type Ports = {
  owner: RuntimeAuthScope;
  workingDirectory: string;
  createAdapter(provider: RuntimeAuthProvider): RuntimeAuthAdapter;
  reportLogin(report: RuntimeAuthLoginReport): Promise<void>;
  reportLogout(report: RuntimeAuthLogoutReport): Promise<void>;
  refresh(): Promise<void>;
  now?: () => number;
};
type Login = {
  id: string;
  provider: RuntimeAuthProvider;
  kiroIdentityCenter?: KiroIdentityCenterOptions;
  abort: AbortController;
  prompt?: { resolve(code: string): void; reject(error: Error): void };
  prompts: number;
  secrets: Set<string>;
  sequence: number;
  reports: Promise<void>;
  completion: Promise<void>;
  terminal: boolean;
  interactionFailed?: boolean;
};

/** One Workspace runtime's private authentication operations, held only in memory. */
export class RuntimeAuthController {
  readonly #logins = new Map<string, Login>();
  readonly #logouts = new Map<RuntimeAuthProvider, Promise<void>>();
  readonly #seen = new Set<string>();
  #stopped = false;
  constructor(private readonly ports: Ports) {}

  /** Closes admission and releases pending prompts before the transport is stopped. */
  stop(): void {
    this.#stopped = true;
    for (const login of this.#logins.values()) {
      login.abort.abort();
      login.prompt?.reject(new Error("Runtime authentication stopped"));
      login.prompt = undefined;
      login.secrets.clear();
    }
    this.#logins.clear();
  }

  async handle(intent: RuntimeAuthIntent): Promise<void> {
    const owner = this.ports.owner;
    if (
      this.#stopped ||
      intent.protocolMajor !== owner.protocolMajor ||
      intent.workspaceId !== owner.workspaceId ||
      intent.computerId !== owner.computerId
    )
      return;
    if (intent.kind === "login_code") {
      const login = this.#logins.get(intent.loginId);
      if (!login?.prompt || login.terminal || login.abort.signal.aborted) return;
      let code: string;
      try {
        code = normalizeRuntimeAuthCode(intent.code);
      } catch {
        return;
      }
      login.secrets.add(code);
      for (const part of code.split("#")) if (part) login.secrets.add(part);
      const prompt = login.prompt;
      login.prompt = undefined;
      prompt.resolve(code);
      return;
    }
    if (intent.kind === "login_cancel") {
      const login = this.#logins.get(intent.loginId);
      if (!login) return;
      login.abort.abort();
      login.prompt?.reject(new Error("Runtime authentication cancelled"));
      login.prompt = undefined;
      await login.completion;
      return;
    }
    if (intent.kind === "logout") {
      if (this.#seen.has(intent.requestId)) return;
      this.#remember(intent.requestId);
      const previous = this.#logouts.get(intent.provider);
      const pending = Promise.resolve().then(async () => {
        await previous;
        await this.#logout(intent);
      });
      this.#logouts.set(intent.provider, pending);
      try {
        await pending;
      } finally {
        if (this.#logouts.get(intent.provider) === pending) this.#logouts.delete(intent.provider);
      }
      return;
    }
    if (this.#seen.has(intent.loginId) || this.#logins.has(intent.loginId)) return;
    this.#remember(intent.loginId);
    if (
      [...this.#logins.values()].some((login) => login.provider === intent.provider) ||
      this.#logouts.has(intent.provider)
    ) {
      await this.ports
        .reportLogin({
          ...this.ports.owner,
          loginId: intent.loginId,
          sequence: 1,
          result: { kind: "busy" },
        })
        .catch(() => {
          logger.warning("Runtime authentication report failed", {
            event: "runtime_auth:report_failed",
          });
        });
      return;
    }
    const login: Login = {
      id: intent.loginId,
      provider: intent.provider,
      ...(intent.kiroIdentityCenter ? { kiroIdentityCenter: intent.kiroIdentityCenter } : {}),
      abort: new AbortController(),
      prompts: 0,
      secrets: new Set(),
      sequence: 0,
      reports: Promise.resolve(),
      completion: Promise.resolve(),
      terminal: false,
    };
    this.#logins.set(login.id, login);
    login.completion = Promise.resolve().then(() => this.#run(login));
    await login.completion;
  }

  async #logout(intent: Extract<RuntimeAuthIntent, { kind: "logout" }>): Promise<void> {
    const login = [...this.#logins.values()].find((value) => value.provider === intent.provider);
    if (login) {
      login.abort.abort();
      login.prompt?.reject(new Error("Runtime authentication cancelled"));
      login.prompt = undefined;
      await login.completion;
    }
    if (this.#stopped) return;
    let result: LogoutResult;
    try {
      const value = await this.ports
        .createAdapter(intent.provider)
        .logout({ workingDirectory: this.ports.workingDirectory });
      if (value.status === "logged_out") result = { kind: "logged_out" };
      else if (value.status === "failed") result = { kind: "failed", reason: value.reason };
      else result = { kind: "unsupported", reason: value.reason };
    } catch {
      result = { kind: "failed", reason: "process_failed" };
    }
    if (this.#stopped) return;
    await this.ports
      .reportLogout({ ...this.ports.owner, requestId: intent.requestId, result })
      .catch(() => {
        logger.warning("Runtime authentication report failed", {
          event: "runtime_auth:report_failed",
        });
      });
    if (this.#stopped) return;
    await this.ports.refresh().catch(() => {
      logger.warning("Runtime authentication status refresh failed", {
        event: "runtime_auth:refresh_failed",
      });
    });
  }

  #remember(id: string): void {
    if (this.#seen.size >= 512) this.#seen.delete(this.#seen.values().next().value!);
    this.#seen.add(id);
  }

  #redact(login: Login, text: string): string {
    for (const secret of [...login.secrets].sort((a, b) => b.length - a.length))
      text = text.replaceAll(secret, "[redacted]");
    return text;
  }

  #report(
    login: Login,
    body: { event: NonNullable<RuntimeAuthLoginReport["event"]> } | { result: LoginResult },
  ): void {
    const value = { ...this.ports.owner, loginId: login.id, sequence: login.sequence + 1, ...body };
    encodeRuntimeAuthLoginReport(value);
    login.sequence++;
    login.reports = login.reports
      .then(() => (this.#stopped ? undefined : this.ports.reportLogin(value)))
      .catch(() => {
        logger.warning("Runtime authentication report failed", {
          event: "runtime_auth:report_failed",
        });
      });
  }

  #event(login: Login, event: RuntimeAuthLoginEvent): void {
    if (this.#stopped || login.terminal || login.abort.signal.aborted) return;
    switch (event.kind) {
      case "code_prompt":
        return; // The prompt callback owns its lifetime and retry count.
      case "auth_url":
        this.#report(login, {
          event: {
            kind: "auth_url",
            url: event.verificationUrl,
            ...(event.instructions
              ? { instructions: this.#redact(login, event.instructions) }
              : {}),
          },
        });
        return;
      case "info":
        this.#report(login, {
          event: { kind: "info", message: this.#redact(login, event.message) },
        });
        return;
      case "device_code":
        if (!event.verificationUrl)
          throw new Error("Runtime authentication verification URL missing");
        if (event.expiresAtMs !== undefined && event.expiresAtMs <= (this.ports.now ?? Date.now)())
          throw new Error("Runtime authentication device code expired");
        this.#report(login, {
          event: {
            kind: "device_code",
            verificationUrl: event.verificationUrl,
            userCode: event.userCode,
            ...(event.expiresAtMs !== undefined
              ? {
                  expiresInSeconds: Math.max(
                    1,
                    Math.ceil((event.expiresAtMs - (this.ports.now ?? Date.now)()) / 1000),
                  ),
                }
              : {}),
          },
        });
    }
  }

  async #run(login: Login): Promise<void> {
    try {
      let result: LoginResult;
      try {
        if (this.#stopped) return;
        const value = await this.ports.createAdapter(login.provider).startLogin(
          {
            workingDirectory: this.ports.workingDirectory,
            ...(login.kiroIdentityCenter ? { kiroIdentityCenter: login.kiroIdentityCenter } : {}),
            onSecret: (secret) => {
              if (secret && !login.terminal) login.secrets.add(secret);
            },
          },
          {
            signal: login.abort.signal,
            onEvent: (event) => {
              try {
                this.#event(login, event);
              } catch {
                login.interactionFailed = true;
                login.abort.abort();
                login.prompt?.reject(new Error("Runtime authentication interaction failed"));
                login.prompt = undefined;
              }
            },
            prompt: (input) => {
              if (login.abort.signal.aborted || login.terminal)
                return Promise.reject(new Error("Runtime authentication cancelled"));
              this.#report(login, {
                event: {
                  kind: "code_prompt",
                  ...(input.message ? { message: this.#redact(login, input.message) } : {}),
                  retry: login.prompts++ > 0,
                },
              });
              return new Promise<string>((resolve, reject) => {
                login.prompt = { resolve, reject };
              });
            },
          },
        );
        result = login.interactionFailed
          ? { kind: "failed", reason: "interaction_failed" }
          : login.abort.signal.aborted
            ? { kind: "cancelled" }
            : this.#result(login, value);
      } catch {
        result = login.interactionFailed
          ? { kind: "failed", reason: "interaction_failed" }
          : login.abort.signal.aborted
            ? { kind: "cancelled" }
            : { kind: "failed", reason: "process_failed" };
      }
      login.terminal = true;
      login.prompt?.reject(new Error("Runtime authentication ended"));
      login.prompt = undefined;
      try {
        this.#report(login, { result });
      } catch {
        this.#report(login, { result: { kind: "failed", reason: "process_failed" } });
      }
      await login.reports;
      if (this.#stopped) return;
      await this.ports.refresh().catch(() => {
        logger.warning("Runtime authentication status refresh failed", {
          event: "runtime_auth:refresh_failed",
        });
      });
    } finally {
      login.terminal = true;
      login.prompt?.reject(new Error("Runtime authentication ended"));
      login.prompt = undefined;
      login.secrets.clear();
      this.#logins.delete(login.id);
    }
  }

  #result(login: Login, result: RuntimeAuthLoginResult): LoginResult {
    if (result.status === "logged_in") {
      const status = sanitizeRuntimeAuthStatus(result.authStatus, login.provider);
      return { kind: "logged_in", ...(status?.account ? { account: status.account } : {}) };
    }
    if (result.status === "failed") return { kind: "failed", reason: result.reason };
    if (result.status === "unsupported") return { kind: "unsupported", reason: result.reason };
    return { kind: result.status };
  }
}
