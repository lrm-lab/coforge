import { SignInFailure } from "./login-failure.server";

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

/** Authing refused to bind the contact (wrong or expired code, or address already in use). */
export class ContactBindRefusedError extends SignInFailure {
  readonly statusCode: number;

  constructor(statusCode: number, providerError?: string) {
    super("contact_bind", {
      reason: "Authing refused to bind the contact",
      providerError,
    });
    this.name = "ContactBindRefusedError";
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
