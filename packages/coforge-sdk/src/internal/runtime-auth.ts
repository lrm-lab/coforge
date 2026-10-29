import { RPC_METHODS } from "./rpc-methods";

export {
  MASK_MARKER,
  MAX_LABEL,
  MAX_METHOD_LABEL,
  RUNTIME_AUTH_FAILURE_DETAIL_CODES,
  RUNTIME_AUTH_LOGIN_FAILURE_REASONS,
  RUNTIME_AUTH_LOGIN_ID_PATTERN,
  RUNTIME_AUTH_LOGOUT_FAILURE_REASONS,
  RUNTIME_AUTH_PROVIDERS,
  RUNTIME_AUTH_UNSUPPORTED_REASONS,
  isRuntimeAuthCode,
  isRuntimeAuthFailureDetailCode,
  type RuntimeAuthFailureDetailCode,
  type RuntimeAuthProvider,
  type RuntimeAuthScope,
  type RuntimeAuthUnsupportedReason,
} from "./runtime-auth-fields";
export * from "./runtime-auth-intent";
export * from "./runtime-auth-login";
export * from "./runtime-auth-logout";

export const RUNTIME_AUTH_INTENT_METHOD = RPC_METHODS.daemonRuntimeAuthIntent;
export const RUNTIME_AUTH_LOGIN_REPORT_METHOD = RPC_METHODS.daemonRuntimeAuthLoginReport;
export const RUNTIME_AUTH_LOGOUT_REPORT_METHOD = RPC_METHODS.daemonRuntimeAuthLogoutReport;
export const RUNTIME_AUTH_CAPABILITY = "runtime-auth:v1" as const;
/** The daemon takes `status_read`: a page asks for one runtime's login status to be read again. */
export const RUNTIME_AUTH_STATUS_READ_CAPABILITY = "runtime-auth:status-read:v1" as const;

export * from "./runtime-auth-kiro";
export const KIRO_IDENTITY_CENTER_AUTH_CAPABILITY = "runtime-auth:kiro-idc:v1" as const;
