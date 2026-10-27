import type {
  RUNTIME_AUTH_LOGIN_FAILURE_REASONS,
  RuntimeAuthAccount,
  RuntimeAuthLoginEvent,
  RuntimeAuthLoginResult,
  RuntimeAuthUnsupportedReason,
} from "@lrm/coforge-sdk/internal";

/** What a login's starter receives, on the channel or from one read. */
export type LoginView = {
  loginId: string;
  sequence: number;
  event?: RuntimeAuthLoginEvent;
  authUrl?: Extract<RuntimeAuthLoginEvent, { kind: "auth_url" }>;
  result?: RuntimeAuthLoginResult;
};

/** Why a login ended without signing in, as the dialog words it. */
export type LoginFailure =
  | { kind: "failed"; reason: (typeof RUNTIME_AUTH_LOGIN_FAILURE_REASONS)[number]; detail?: string }
  | { kind: "unsupported"; reason: RuntimeAuthUnsupportedReason }
  | { kind: "busy" | "offline" | "needs_upgrade" | "cancelled" | "ended" | "start_failed" };

/**
 * One sign-in, as the dialog shows it. A running login keeps what each kind of event last said:
 * an `info` line must not replace the device code the reader still has to type.
 */
export type LoginState =
  | { phase: "starting" }
  | {
      phase: "running";
      loginId: string;
      sequence: number;
      link?: Extract<RuntimeAuthLoginEvent, { kind: "auth_url" | "device_code" }>;
      /** When the device code stops working, from the moment it arrived. */
      expiresAtMs?: number;
      info?: string;
      /** The runtime asks for the code its sign-in page shows; `""` when it gives no wording. */
      prompt?: string;
      /** A code was sent and nothing has answered it yet. */
      checking: boolean;
      /** The runtime asked for the code again: it did not take the one it was sent. */
      rejected: boolean;
    }
  | { phase: "signed_in"; account?: RuntimeAuthAccount }
  | { phase: "failed"; failure: LoginFailure };

export type LoginAction =
  | { type: "started"; loginId: string }
  | { type: "start_refused"; status: "busy" | "offline" | "needs_upgrade" }
  | { type: "start_failed" }
  | { type: "view"; view: LoginView; now: number }
  | { type: "code_sent" }
  | { type: "code_invalid" }
  | { type: "ended" };

export const initialLoginState: LoginState = { phase: "starting" };

/** The failures worth a Try again: the next attempt can go differently. */
export function retryable(failure: LoginFailure): boolean {
  switch (failure.kind) {
    case "failed":
      return failure.reason !== "interaction_failed";
    case "unsupported":
    case "needs_upgrade":
      return false;
    default:
      return true;
  }
}

function finished(result: RuntimeAuthLoginResult): LoginState {
  switch (result.kind) {
    case "logged_in":
      return { phase: "signed_in", account: result.account };
    case "failed":
      return {
        phase: "failed",
        failure: {
          kind: "failed",
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
        },
      };
    case "unsupported":
      return { phase: "failed", failure: { kind: "unsupported", reason: result.reason } };
    case "cancelled":
    case "busy":
      return { phase: "failed", failure: { kind: result.kind } };
  }
}

/**
 * The channel and the catch-up read deliver the same views in no fixed order, and may repeat one:
 * a view only moves the login forward when its sequence is newer, and an ended login stays ended.
 */
export function loginReducer(state: LoginState, action: LoginAction): LoginState {
  if (state.phase === "signed_in" || state.phase === "failed") return state;
  switch (action.type) {
    case "started":
      return state.phase === "starting"
        ? {
            phase: "running",
            loginId: action.loginId,
            sequence: -1,
            checking: false,
            rejected: false,
          }
        : state;
    case "start_refused":
      return { phase: "failed", failure: { kind: action.status } };
    case "start_failed":
      return { phase: "failed", failure: { kind: "start_failed" } };
    case "ended":
      return { phase: "failed", failure: { kind: "ended" } };
  }
  if (state.phase !== "running") return state;
  switch (action.type) {
    case "code_sent":
      return { ...state, checking: true, rejected: false };
    case "code_invalid":
      return { ...state, checking: false };
    case "view": {
      const { view } = action;
      if (view.loginId !== state.loginId || view.sequence <= state.sequence) return state;
      if (view.result) return finished(view.result);
      const next = {
        ...state,
        sequence: view.sequence,
        ...(state.link || !view.authUrl ? {} : { link: view.authUrl }),
      };
      const event = view.event;
      if (!event) return next;
      switch (event.kind) {
        case "auth_url":
          return { ...next, link: event, expiresAtMs: undefined };
        case "device_code":
          return {
            ...next,
            link: event,
            expiresAtMs:
              event.expiresInSeconds === undefined
                ? undefined
                : action.now + event.expiresInSeconds * 1000,
          };
        case "info":
          return { ...next, info: event.message };
        case "code_prompt":
          // A prompt after a sent code, or one the runtime marks as a retry, means the code
          // was not taken.
          return {
            ...next,
            prompt: event.message ?? "",
            rejected: Boolean(event.retry) || state.checking,
            checking: false,
          };
      }
    }
  }
  return state;
}

/** Only an `https:` page is opened: the link comes from a CLI on the Computer, not from us. */
export function safeSignInUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
