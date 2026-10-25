import { z } from "zod";
import { RUNTIME_AUTH_LOGIN_ID_PATTERN, RUNTIME_AUTH_PROVIDERS } from "@lrm/coforge-sdk/internal";

const computerId = z.string().min(1);
const loginId = z.string().regex(RUNTIME_AUTH_LOGIN_ID_PATTERN);

export const startRuntimeAuthLoginInputSchema = z.object({
  computerId,
  provider: z.enum(RUNTIME_AUTH_PROVIDERS),
});
/** The pasted code may carry whitespace; the server removes it and checks what is left. */
export const submitRuntimeAuthCodeInputSchema = z.object({
  computerId,
  loginId,
  code: z.string().min(1).max(4096),
});
export const runtimeAuthLoginInputSchema = z.object({ computerId, loginId });
export const runtimeAuthLogoutInputSchema = z.object({
  computerId,
  provider: z.enum(RUNTIME_AUTH_PROVIDERS),
  requestId: z.uuid(),
});
export const readRuntimeAuthLogoutInputSchema = z.object({ computerId, requestId: z.uuid() });
