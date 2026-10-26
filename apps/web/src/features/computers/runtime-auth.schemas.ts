import { z } from "zod";
import {
  runtimeAuthKiroOptions,
  RUNTIME_AUTH_LOGIN_ID_PATTERN,
  RUNTIME_AUTH_PROVIDERS,
} from "@lrm/coforge-sdk/internal";

const computerId = z.string().min(1);
const loginId = z.string().regex(RUNTIME_AUTH_LOGIN_ID_PATTERN);

export const startRuntimeAuthLoginInputSchema = z
  .object({
    computerId,
    provider: z.enum(RUNTIME_AUTH_PROVIDERS),
    kiroIdentityCenter: z.object({ startUrl: z.string(), region: z.string() }).optional(),
  })
  .superRefine((value, context) => {
    try {
      runtimeAuthKiroOptions(value.provider, value.kiroIdentityCenter);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["kiroIdentityCenter"],
        message: "Enter a valid Kiro enterprise Start URL and AWS Region",
      });
    }
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
