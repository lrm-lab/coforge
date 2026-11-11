import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import {
  encodeRuntimeAuthIntent,
  runtimeAuthKiroLogin,
  type KiroIdentityCenterOptions,
  isRuntimeAuthCode,
  type RuntimeAuthLoginEvent,
  type RuntimeAuthLoginReport,
  type RuntimeAuthLoginResult,
  type RuntimeAuthLogoutReport,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthProvider,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import { runtimeAuthChannel } from "#src/features/computers/runtime-auth-realtime";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
import type {
  RuntimeAuthLoginRecord,
  RuntimeAuthLogoutRecord,
  RuntimeAuthScope as Scope,
  RuntimeAuthStore,
} from "./runtime-auth-store.server";

export type Principal = { userId: string; workspaceId: string };

export interface RuntimeAuthAuthorization {
  /** The Computer's owner, or an owner or admin of a Workspace the Computer is connected to; not
   * for another member's default cloud Computer, which only its owner manages. With a `provider`,
   * the runtime must also be one the viewer sees on the Computer page: the owner's always,
   * anyone else's once public. */
  canManage(scope: Scope & { userId: string; provider?: RuntimeProvider }): Promise<boolean>;
}

/** What a sign-in or sign-out cannot start on: the Computer is away, or too old to take it. */
export type RuntimeAuthUnavailable = "offline" | "needs_upgrade";

/** A login as its starter may see it: everything but who started it. */
export type RuntimeAuthLoginView = {
  loginId: string;
  provider: RuntimeAuthProvider;
  sequence: number;
  event?: RuntimeAuthLoginEvent;
  authUrl?: Extract<RuntimeAuthLoginEvent, { kind: "auth_url" }>;
  result?: RuntimeAuthLoginResult;
};

export type RuntimeAuthLogoutView = {
  requestId: string;
  provider: RuntimeAuthProvider;
  result?: RuntimeAuthLogoutResult;
};

/** What the starter's channel carries; the page reads the same shape once on open. */
export type RuntimeAuthSignal =
  | ({ type: typeof REALTIME_EVENTS.runtimeAuthLogin; computerId: string } & RuntimeAuthLoginView)
  | ({ type: typeof REALTIME_EVENTS.runtimeAuthLogout; computerId: string } & RuntimeAuthLogoutView)
  /** The Computer stored a newer login status report: whoever shows it reads it again. */
  | { type: typeof REALTIME_EVENTS.runtimeAuthStatus; computerId: string };

function logoutView(record: RuntimeAuthLogoutRecord): RuntimeAuthLogoutView {
  const { requestId, provider, result } = record;
  return { requestId, provider, ...(result && { result }) };
}

const encoder = new TextEncoder();

function loginView(record: RuntimeAuthLoginRecord): RuntimeAuthLoginView {
  const { loginId, provider, sequence, event, authUrl, result } = record;
  return {
    loginId,
    provider,
    sequence,
    ...(event && { event }),
    ...(authUrl && { authUrl }),
    ...(result && { result }),
  };
}

/**
 * Signing a Code Agent runtime in or out on a Computer from the web. The daemon drives the
 * runtime's own flow; this keeps one login per provider per Computer, shows the person who started
 * it what the flow asks of them, and takes the code they paste back to the daemon. The code goes
 * through here once, to the control channel, and is neither stored nor logged.
 */
export class RuntimeAuth {
  constructor(
    private readonly authorization: RuntimeAuthAuthorization,
    private readonly store: RuntimeAuthStore,
    private readonly api: Pick<CentrifugoServerApi, "publish">,
    /** Whether a live daemon is on the Computer's control channel right now (status cache and
     * channel presence, fail open); a publish into an empty channel is dropped unheard. */
    private readonly online: (scope: Scope) => Promise<boolean>,
    private readonly capability: {
      supports(
        workspaceId: string,
        computerId: string,
        provider?: RuntimeAuthProvider,
      ): Promise<boolean>;
      /** Whether the Computer takes `status_read`; one that does not is never asked. */
      supportsStatusRead(workspaceId: string, computerId: string): Promise<boolean>;
      /** Whether the Computer can start Kiro's free sign-in (Builder ID, Google, GitHub). */
      supportsKiroFree(workspaceId: string, computerId: string): Promise<boolean>;
    },
    private readonly newLoginId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  async startLogin(
    principal: Principal,
    input: {
      computerId: string;
      provider: RuntimeAuthProvider;
      kiroIdentityCenter?: KiroIdentityCenterOptions;
      /** Kiro's free sign-in (Builder ID, Google, GitHub) instead of an identity center. */
      kiroLicense?: "pro" | "free";
      antigravityMethodId?: "oauth-personal" | "oauth-business";
    },
  ): Promise<{ status: "started"; loginId: string } | { status: "busy" | RuntimeAuthUnavailable }> {
    const scope = await this.authorize(principal, input.computerId, input.provider);
    const kiro = runtimeAuthKiroLogin(input.provider, input.kiroIdentityCenter, input.kiroLicense);
    const unavailable = await this.unavailable(scope, input.provider);
    if (unavailable) return { status: unavailable };
    const loginId = this.newLoginId();
    const began = await this.store.begin(
      scope,
      { loginId, provider: input.provider, userId: principal.userId },
      this.now(),
    );
    if (began === "busy") return { status: "busy" };
    try {
      await this.publishIntent(scope, {
        kind: "login_start",
        loginId,
        provider: input.provider,
        ...(kiro?.license === "pro" ? { kiroIdentityCenter: kiro.identityCenter } : {}),
        ...(kiro ? { kiroLicense: kiro.license } : {}),
        ...(input.antigravityMethodId ? { antigravityMethodId: input.antigravityMethodId } : {}),
      });
    } catch {
      // The provider must not stay locked for a login whose intent never left.
      await this.store
        .fail(scope, loginId, { kind: "failed", reason: "process_failed" })
        .catch(() => {});
      return { status: "offline" };
    }
    return { status: "started", loginId };
  }

  /**
   * Whether Kiro's sign-in on this Computer may be the free one (Builder ID, Google, GitHub) as
   * well as an identity center: the sign-in dialog asks which only when it may. Only someone who
   * may sign the Computer's Kiro in learns it.
   */
  async kiroFreeSupported(principal: Principal, input: { computerId: string }): Promise<boolean> {
    const scope = await this.authorize(principal, input.computerId, RUNTIME_PROVIDER.KIRO);
    return this.capability.supportsKiroFree(scope.workspaceId, scope.computerId);
  }

  /**
   * Asks the Computer to read one runtime's login status again, as when its page opens: it may
   * have been signed in or out on the Computer itself, which nothing else tells anyone. The report
   * comes back like every other one and reaches the caller on their own channel.
   */
  async requestStatusRead(
    principal: Principal,
    input: { computerId: string; provider: RuntimeAuthProvider },
  ): Promise<"requested" | RuntimeAuthUnavailable> {
    const scope = await this.authorize(principal, input.computerId, input.provider);
    const [online, supported] = await Promise.all([
      this.online(scope),
      this.capability.supportsStatusRead(scope.workspaceId, scope.computerId),
    ]);
    if (!online) return "offline";
    if (!supported) return "needs_upgrade";
    try {
      await this.publishIntent(scope, { kind: "status_read", provider: input.provider });
    } catch {
      return "offline";
    }
    return "requested";
  }

  /** Hands the pasted code to the daemon. Only the person who started the login may. */
  async submitCode(
    principal: Principal,
    input: { computerId: string; loginId: string; code: string },
  ): Promise<"sent" | "invalid_code" | "not_available"> {
    const { scope, login } = await this.authorizeOwnLogin(principal, input);
    if (!login || login.result) return "not_available";
    // The same rule as the daemon's: a pasted code is one run of characters, whitespace is not part.
    const code = input.code.replace(/\s/gu, "");
    if (!isRuntimeAuthCode(code)) return "invalid_code";
    if (!(await this.online(scope))) return "not_available";
    try {
      await this.publishIntent(scope, { kind: "login_code", loginId: input.loginId, code });
    } catch {
      return "not_available";
    }
    return "sent";
  }

  async cancelLogin(
    principal: Principal,
    input: { computerId: string; loginId: string },
  ): Promise<"sent" | "not_available"> {
    const { scope, login } = await this.authorizeOwnLogin(principal, input);
    if (!login || login.result) return "not_available";
    if (!(await this.online(scope))) return "not_available";
    try {
      await this.publishIntent(scope, { kind: "login_cancel", loginId: input.loginId });
    } catch {
      return "not_available";
    }
    return "sent";
  }

  /** What a page that was closed or reconnected missed; nothing for a login that is not theirs. */
  async readLogin(
    principal: Principal,
    input: { computerId: string; loginId: string },
  ): Promise<RuntimeAuthLoginView | undefined> {
    const { login } = await this.authorizeOwnLogin(principal, input);
    return login && loginView(login);
  }

  /** Idempotent per request id: a repeated request reads back the first one's outcome. */
  async logout(
    principal: Principal,
    input: { computerId: string; provider: RuntimeAuthProvider; requestId: string },
  ): Promise<RuntimeAuthLogoutView | { status: RuntimeAuthUnavailable }> {
    const scope = await this.authorize(principal, input.computerId, input.provider);
    const existing = await this.store.readLogout(scope, input.requestId);
    if (existing) return this.ownLogoutView(principal, existing);
    const unavailable = await this.unavailable(scope, input.provider);
    if (unavailable) return { status: unavailable };
    const { record, created } = await this.store.beginLogout(scope, {
      requestId: input.requestId,
      provider: input.provider,
      userId: principal.userId,
    });
    if (!created) return this.ownLogoutView(principal, record);
    try {
      await this.publishIntent(scope, {
        kind: "logout",
        requestId: input.requestId,
        provider: input.provider,
      });
    } catch {
      await this.store
        .reportLogout(scope, input.requestId, { kind: "failed", reason: "process_failed" })
        .catch(() => {});
      return { status: "offline" };
    }
    return this.ownLogoutView(principal, record);
  }

  async readLogout(
    principal: Principal,
    input: { computerId: string; requestId: string },
  ): Promise<RuntimeAuthLogoutView | undefined> {
    const scope = { workspaceId: principal.workspaceId, computerId: input.computerId };
    const record = await this.store.readLogout(scope, input.requestId);
    // The runtime the request signed out, as it stands now: the owner may have made it private.
    await this.authorize(principal, input.computerId, record?.provider);
    return record && this.ownLogoutView(principal, record);
  }

  /**
   * The daemon's progress or result for a login. False when the login is not one this Computer
   * has open (the RPC answers 403); a stale or repeated report is accepted and dropped.
   */
  async receiveLoginReport(scope: Scope, report: RuntimeAuthLoginReport): Promise<boolean> {
    if (report.workspaceId !== scope.workspaceId || report.computerId !== scope.computerId)
      return false;
    const applied = await this.store.report(
      scope,
      report.loginId,
      report.sequence,
      "event" in report && report.event ? { event: report.event } : { result: report.result! },
    );
    if (applied === "unknown") return false;
    if (applied !== "ignored")
      await this.signal(applied.userId, {
        type: REALTIME_EVENTS.runtimeAuthLogin,
        computerId: scope.computerId,
        ...loginView(applied),
      });
    return true;
  }

  async receiveLogoutReport(scope: Scope, report: RuntimeAuthLogoutReport): Promise<boolean> {
    if (report.workspaceId !== scope.workspaceId || report.computerId !== scope.computerId)
      return false;
    const applied = await this.store.reportLogout(scope, report.requestId, report.result);
    if (applied === "unknown") return false;
    if (applied !== "ignored")
      await this.signal(applied.userId, {
        type: REALTIME_EVENTS.runtimeAuthLogout,
        computerId: scope.computerId,
        ...logoutView(applied),
      });
    return true;
  }

  /** The login's starter picking it up again (the code, the cancel, the read): authorized again,
   * for the runtime it was started on as it stands now. A login that is not theirs is not found,
   * and still needs the Computer. */
  private async authorizeOwnLogin(
    principal: Principal,
    input: { computerId: string; loginId: string },
  ) {
    const scope = { workspaceId: principal.workspaceId, computerId: input.computerId };
    const login = await this.ownLogin(scope, principal, input.loginId);
    await this.authorize(principal, input.computerId, login?.provider);
    return { scope, login };
  }

  /** `provider` when the call names a runtime. */
  private async authorize(
    principal: Principal,
    computerId: string,
    provider?: RuntimeProvider,
  ): Promise<Scope> {
    const scope = { workspaceId: principal.workspaceId, computerId };
    if (!(await this.authorization.canManage({ ...scope, userId: principal.userId, provider })))
      throw new Error("Computer is not available");
    return scope;
  }

  private async unavailable(
    scope: Scope,
    provider: RuntimeAuthProvider,
  ): Promise<RuntimeAuthUnavailable | undefined> {
    const [online, supported] = await Promise.all([
      this.online(scope),
      this.capability.supports(scope.workspaceId, scope.computerId, provider),
    ]);
    if (!online) return "offline";
    return supported ? undefined : "needs_upgrade";
  }

  /** The login, only to the person who started it. */
  private async ownLogin(scope: Scope, principal: Principal, loginId: string) {
    const login = await this.store.read(scope, loginId, this.now());
    return login?.userId === principal.userId ? login : undefined;
  }

  /** The sign-out, only to the person who requested it. */
  private ownLogoutView(principal: Principal, record: RuntimeAuthLogoutRecord) {
    if (record.userId !== principal.userId) throw new Error("Computer is not available");
    return logoutView(record);
  }

  private publishIntent(
    scope: Scope,
    intent:
      | {
          kind: "login_start";
          loginId: string;
          provider: RuntimeAuthProvider;
          kiroIdentityCenter?: KiroIdentityCenterOptions;
        }
      | { kind: "login_code"; loginId: string; code: string }
      | { kind: "login_cancel"; loginId: string }
      | { kind: "logout"; requestId: string; provider: RuntimeAuthProvider }
      | { kind: "status_read"; provider: RuntimeAuthProvider },
  ) {
    return this.api.publish(
      daemonControlChannel(scope.workspaceId, scope.computerId),
      encodeRuntimeAuthIntent({ protocolMajor: 1, ...scope, ...intent }),
    );
  }

  /** Best effort: the page re-reads on open, and a lost push only delays what it shows. */
  private async signal(userId: string, signal: RuntimeAuthSignal) {
    try {
      await this.api.publish(runtimeAuthChannel(userId), encoder.encode(JSON.stringify(signal)));
    } catch {
      // The starter's page catches up from `readLogin`.
    }
  }
}
