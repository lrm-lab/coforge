import { RPC_METHODS } from "./rpc-methods";

export * from "./runtime-auth-fields";
export * from "./runtime-auth-intent";
export * from "./runtime-auth-login";
export * from "./runtime-auth-logout";

export const RUNTIME_AUTH_INTENT_METHOD = RPC_METHODS.daemonRuntimeAuthIntent;
export const RUNTIME_AUTH_LOGIN_REPORT_METHOD = RPC_METHODS.daemonRuntimeAuthLoginReport;
export const RUNTIME_AUTH_LOGOUT_REPORT_METHOD = RPC_METHODS.daemonRuntimeAuthLogoutReport;
export const RUNTIME_AUTH_CAPABILITY = "runtime-auth:v1" as const;
