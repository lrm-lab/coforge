import type { CodeDestination } from "#src/features/auth/code-destination";
import { SignInFailure } from "./login-failure.server";

/**
 * What the Web server calls at Authing: the Authentication API v3 password, verification-code and
 * GitHub sign-ins (and sending the code), setting a password with a code, the OIDC userinfo
 * endpoint, and token revocation. The
 * lowest layer of sign-in: it speaks HTTP and knows nothing of sessions or users.
 */
export type AuthingConfig = {
  appId: string;
  appSecret: string;
  /** The Authentication API's host: the issuer without its `/oidc` path. */
  appHost: string;
  userinfoEndpoint: string;
  revocationEndpoint: string;
};

export type AuthingTokens = { accessToken: string };

export type AuthingProfile = {
  sub: string;
  email?: string | null;
  /** Whether Authing verified the address; only a verified one may match a platform operator. */
  email_verified?: boolean | null;
  /** The OIDC claim (`phone` is in the scope); Authing answers `phone_number`, and its own
   * `phone` field on some pools. Either, read by `browser-login` into the account's phone. */
  phone_number?: string | null;
  phone?: string | null;
  /** Whether Authing verified the number; its own field on some pools. Only a verified number may
   * match a platform operator, so one anyone can type into their own account cannot. */
  phone_number_verified?: boolean | null;
  phone_verified?: boolean | null;
  name?: string | null;
  nickname?: string | null;
  preferred_username?: string | null;
};

const REFUSAL_REASONS = {
  password_sign_in: "Authing refused the email and password",
  passcode_sign_in: "Authing refused the verification code",
  github_sign_in: "Authing refused the GitHub authorization code",
} as const;

/** The ways of signing in, each a step Authing can refuse what the person gave. */
export type SignInStage = keyof typeof REFUSAL_REASONS;

/** Authing answered the sign-in and refused what was typed (the email and password, or the
 * verification code) or the code GitHub sent. A `SignInFailure` of its own step, so it passes
 * through `atSignInStage` as itself. */
export class InvalidCredentialsError extends SignInFailure {
  /** Authing's `statusCode`, logged with its `apiCode` so that a refusal that is really a
   * misconfigured app can be told from a wrong password. */
  readonly statusCode: number;

  constructor(statusCode: number, providerError?: string, stage: SignInStage = "password_sign_in") {
    super(stage, { reason: REFUSAL_REASONS[stage], providerError });
    this.name = "InvalidCredentialsError";
    this.statusCode = statusCode;
  }
}

/** Authing refused a password reset: the verification code (`reset_code`), or the new password
 * (`password`, which its policy does not accept). A `SignInFailure` of its own step. */
export class PasswordResetRefusedError extends SignInFailure {
  readonly statusCode: number;
  readonly refused: "reset_code" | "password";

  constructor(refused: "reset_code" | "password", statusCode: number, providerError?: string) {
    super("password_reset", {
      reason:
        refused === "reset_code"
          ? "Authing refused the verification code of a password reset"
          : "Authing refused the new password",
      providerError,
    });
    this.name = "PasswordResetRefusedError";
    this.refused = refused;
    this.statusCode = statusCode;
  }
}

/** Authing refused to send a verification code (a destination it does not know, for a password
 * reset), as it answers a request it will not serve; not a failure on its side. A `SignInFailure`
 * of the send step. */
export class CodeSendRefusedError extends SignInFailure {
  constructor(status: number, providerError?: string) {
    super("send_code", {
      reason: "Authing refused to send the verification code",
      status,
      providerError,
    });
    this.name = "CodeSendRefusedError";
  }
}

/** Authing would not send a verification code because it was asked too often (it allows one per
 * destination per minute). A `SignInFailure` of the send step. */
export class CodeSendThrottledError extends SignInFailure {
  constructor(providerError?: string) {
    super("send_code", { reason: "Authing throttled the verification code", providerError });
    this.name = "CodeSendThrottledError";
  }
}

export type AuthingAuthentication = {
  /** Throws `InvalidCredentialsError` when Authing refused the credentials, `SignInFailure` when
   * the sign-in could not be completed for any other reason. */
  signInWithPassword(input: {
    email: string;
    password: string;
    /** The person's own address, which Authing's risk checks would otherwise take to be ours. */
    clientIp?: string;
  }): Promise<AuthingTokens>;
  /** Signs in with a verification code Authing sent to `destination`, making the account when
   * there is none (`autoRegister`). Throws `InvalidCredentialsError` when Authing refused the code,
   * `SignInFailure` when the sign-in could not be completed for any other reason. */
  signInWithPasscode(input: {
    destination: CodeDestination;
    passCode: string;
    /** The person's own address, as for `signInWithPassword`. */
    clientIp?: string;
  }): Promise<AuthingTokens>;
  /** Signs in with the `code` GitHub sent the browser back with, which Authing exchanges at
   * GitHub through its connection `connection` (a connection identifier of the user pool), making
   * the account when there is none. Throws `InvalidCredentialsError` when Authing refused the
   * code, `SignInFailure` when the sign-in could not be completed for any other reason. */
  signInWithGitHubCode(input: { code: string; connection: string }): Promise<AuthingTokens>;
  /** Has Authing send a sign-in verification code by SMS or email. Throws `CodeSendThrottledError`
   * when Authing was asked too often, `SignInFailure` when the code could not be sent. */
  sendSignInCode(destination: CodeDestination): Promise<void>;
  /** Has Authing send the code that sets a new password, by SMS or email. As `sendSignInCode`,
   * and `CodeSendRefusedError` when Authing refused the request (it has no such account). */
  sendResetCode(destination: CodeDestination): Promise<void>;
  /** Trades the verification code Authing sent for the single-use token that sets the password
   * (`resetPassword`). Throws `PasswordResetRefusedError` (`reset_code`) when Authing refused the
   * code, `SignInFailure` when it could not be checked. */
  verifyResetCode(input: { destination: CodeDestination; passCode: string }): Promise<string>;
  /** Sets the account's password with the token `verifyResetCode` returned. Throws
   * `PasswordResetRefusedError` (`password`) when Authing did not accept the password,
   * `SignInFailure` when it could not be set. */
  resetPassword(input: { resetToken: string; password: string }): Promise<void>;
  fetchUserInfo(accessToken: string): Promise<AuthingProfile>;
  /** Throws when Authing did not revoke the token. */
  revokeToken(token: string): Promise<void>;
};

const SIGN_IN_TIMEOUT_MS = 10_000;
const REVOCATION_TIMEOUT_MS = 3_000;

type SignInResponse = {
  statusCode?: unknown;
  apiCode?: unknown;
  message?: unknown;
  data?: { access_token?: unknown; passwordResetToken?: unknown } | null;
};

const SIGN_IN_SCOPE = "openid profile email phone";
/** What Authing's own refusal to send another code says, when its `statusCode` does not. */
const SEND_TOO_FREQUENT = /frequent|too many|频繁/i;

/** Authing's `apiCode` as text, when it answered one. */
function providerErrorOf(body: SignInResponse | null): string | undefined {
  return typeof body?.apiCode === "number" || typeof body?.apiCode === "string"
    ? String(body.apiCode)
    : undefined;
}

/** Authing's own `statusCode` of an answer, when it gave one. */
function statusCodeOf(body: SignInResponse | null): number | undefined {
  return typeof body?.statusCode === "number" ? body.statusCode : undefined;
}

/** Whether Authing refused the request itself (what was typed, or a destination it does not
 * serve) rather than failing to serve it. It reports a refusal as a client-error `statusCode` in
 * the JSON (the HTTP status may be 200 or 4xx); a rate limit, a server error and an answer that is
 * none of these are failures, not refusals. */
function isRefusal(status: number, statusCode: number | undefined): statusCode is number {
  return (
    status < 500 &&
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 429
  );
}

/** One call of the Authentication API: a JSON POST for this app. A gateway's HTML error page is
 * not JSON; the HTTP status still says what happened. */
async function postAuthing(
  config: AuthingConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: SignInResponse | null }> {
  const response = await fetch(`${config.appHost}/api/v3/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-authing-app-id": config.appId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json().catch(() => null)) as SignInResponse | null,
  };
}

/** `POST /api/v3/signin` (or, for a social connection, `signin-by-mobile`) with one connection's
 * payload; the three kinds of answer are the tokens, a refusal of what was typed, and a failure of
 * the sign-in itself. */
async function requestSignIn(
  config: AuthingConfig,
  stage: SignInStage,
  input: {
    path?: "signin" | "signin-by-mobile";
    connection: string;
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
    clientIp?: string | undefined;
  },
): Promise<AuthingTokens> {
  const { ok, status, body } = await postAuthing(config, input.path ?? "signin", {
    connection: input.connection,
    ...input.payload,
    options: {
      scope: SIGN_IN_SCOPE,
      ...input.options,
      ...(input.clientIp ? { clientIp: input.clientIp } : {}),
    },
    client_id: config.appId,
    client_secret: config.appSecret,
  });
  const statusCode = statusCodeOf(body);
  const accessToken = body?.data?.access_token;
  if (ok && statusCode === 200 && typeof accessToken === "string" && accessToken) {
    return { accessToken };
  }
  const providerError = providerErrorOf(body);
  // A rate limit, a server error and an answer that is none of these are failures of the
  // sign-in, not of what was typed.
  if (isRefusal(status, statusCode)) {
    throw new InvalidCredentialsError(statusCode, providerError, stage);
  }
  throw new SignInFailure(stage, { status, providerError });
}

/** How a destination is named in the bodies of the send and verify calls (the SMS ones spell the
 * number `phoneNumber`, where the sign-in's passcode payload spells it `phone`). */
function destinationFields(destination: CodeDestination) {
  return destination.kind === "email"
    ? { email: destination.email }
    : { phoneNumber: destination.phone, phoneCountryCode: destination.countryCode };
}

/** `POST /api/v3/send-sms` or `send-email` for one channel (what the code is for). */
async function requestCodeSend(
  config: AuthingConfig,
  channel: "CHANNEL_LOGIN" | "CHANNEL_RESET_PASSWORD",
  destination: CodeDestination,
): Promise<void> {
  const { ok, status, body } = await postAuthing(
    config,
    destination.kind === "email" ? "send-email" : "send-sms",
    { channel, ...destinationFields(destination) },
  );
  const statusCode = statusCodeOf(body);
  if (ok && statusCode === 200) return;
  const providerError = providerErrorOf(body);
  // The message is read only to tell the throttle apart; it is never logged.
  if (
    status === 429 ||
    statusCode === 429 ||
    (typeof body?.message === "string" && SEND_TOO_FREQUENT.test(body.message))
  ) {
    throw new CodeSendThrottledError(providerError);
  }
  if (isRefusal(status, statusCode)) throw new CodeSendRefusedError(status, providerError);
  throw new SignInFailure("send_code", { status, providerError });
}

export function createAuthingAuthentication(config: AuthingConfig): AuthingAuthentication {
  return {
    signInWithPassword(input) {
      return requestSignIn(config, "password_sign_in", {
        connection: "PASSWORD",
        payload: { passwordPayload: { email: input.email, password: input.password } },
        clientIp: input.clientIp,
      });
    },
    signInWithPasscode(input) {
      const { destination, passCode } = input;
      return requestSignIn(config, "passcode_sign_in", {
        connection: "PASSCODE",
        payload: {
          passCodePayload:
            destination.kind === "email"
              ? { email: destination.email, passCode }
              : { phone: destination.phone, phoneCountryCode: destination.countryCode, passCode },
        },
        options: { autoRegister: true },
        clientIp: input.clientIp,
      });
    },
    signInWithGitHubCode(input) {
      // Authing takes the GitHub code on `signin-by-mobile`, naming the pool's connection by its
      // identifier. No `clientIp`: this call was not verified to take one.
      return requestSignIn(config, "github_sign_in", {
        path: "signin-by-mobile",
        connection: "github",
        payload: { extIdpConnidentifier: input.connection, githubPayload: { code: input.code } },
      });
    },
    sendSignInCode(destination) {
      return requestCodeSend(config, "CHANNEL_LOGIN", destination);
    },
    sendResetCode(destination) {
      return requestCodeSend(config, "CHANNEL_RESET_PASSWORD", destination);
    },
    async verifyResetCode({ destination, passCode }) {
      const payload = { ...destinationFields(destination), passCode };
      const { ok, status, body } = await postAuthing(config, "verify-reset-password-request", {
        verifyMethod: destination.kind === "email" ? "EMAIL_PASSCODE" : "PHONE_PASSCODE",
        [destination.kind === "email" ? "emailPassCodePayload" : "phonePassCodePayload"]: payload,
      });
      const statusCode = statusCodeOf(body);
      const resetToken = body?.data?.passwordResetToken;
      if (ok && statusCode === 200 && typeof resetToken === "string" && resetToken) {
        return resetToken;
      }
      const providerError = providerErrorOf(body);
      if (isRefusal(status, statusCode)) {
        throw new PasswordResetRefusedError("reset_code", statusCode, providerError);
      }
      throw new SignInFailure("password_reset", { status, providerError });
    },
    async resetPassword({ resetToken, password }) {
      const { ok, status, body } = await postAuthing(config, "reset-password", {
        passwordResetToken: resetToken,
        password,
      });
      const statusCode = statusCodeOf(body);
      if (ok && statusCode === 200) return;
      const providerError = providerErrorOf(body);
      // The token was issued a moment ago, so a refusal is of the password.
      if (isRefusal(status, statusCode)) {
        throw new PasswordResetRefusedError("password", statusCode, providerError);
      }
      throw new SignInFailure("password_reset", { status, providerError });
    },
    async fetchUserInfo(accessToken) {
      const response = await fetch(config.userinfoEndpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
      });
      if (!response.ok) throw new SignInFailure("userinfo", { status: response.status });
      return (await response.json()) as AuthingProfile;
    },
    async revokeToken(token) {
      const response = await fetch(config.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          client_id: config.appId,
          client_secret: config.appSecret,
        }),
        signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`token revocation answered ${response.status}`);
    },
  };
}
