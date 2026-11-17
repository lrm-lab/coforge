import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  isSignInCode,
  parseCodeDestination,
  typedDestination,
} from "#src/features/auth/code-destination";
import { declareNoStore } from "#src/features/no-store-response.server";
import { readCookie } from "#src/server/auth/browser-login.server";
import { readSignInConfigOrNull } from "#src/server/auth/config.server";
import {
  bindAccountContact,
  CONTACT_BIND_COOKIE,
  contactBindEndingCookie,
  contactBindStore,
  sendContactBindCode,
} from "#src/server/auth/contact-binding.server";
import { getCodeSendRateLimits } from "#src/server/auth/sign-in-rate-limits.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { clientAddress, publicOrigin } from "#src/server/http/public-origin.server";
import { authMiddleware } from "./function-auth";

function readBindTokenFromRequest(): string | null {
  const cookieHeader = getRequest().headers.get("cookie") ?? "";
  const token = readCookie(cookieHeader, CONTACT_BIND_COOKIE)?.trim();
  return token ? token : null;
}

export const requestContactBindCodeFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ destination: typedDestination }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    const bindToken = readBindTokenFromRequest();
    if (!bindToken) return { ok: false, problem: "invalid_bind_token" } as const;
    const destination = parseCodeDestination(data.destination);
    if (!destination) return { ok: false, problem: "invalid_destination" } as const;
    const store = contactBindStore();
    if (!store) return { ok: false, problem: "unavailable" } as const;
    const signInConfig = await readSignInConfigOrNull(process.env);
    if (!signInConfig) return { ok: false, problem: "send_failed" } as const;
    const result = await sendContactBindCode({
      store,
      userId: context.user.id,
      bindToken,
      destination,
      config: signInConfig.config,
      rateLimits: getCodeSendRateLimits(),
      clientAddress: clientAddress(getRequest()),
    });
    return result.status === "sent"
      ? ({ ok: true } as const)
      : ({ ok: false, problem: result.status } as const);
  });

export const bindAccountContactFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      destination: typedDestination,
      code: z.string().trim().max(32),
    }),
  )
  .handler(async ({ data, context }) => {
    declareNoStore();
    const request = getRequest();
    const bindToken = readBindTokenFromRequest();
    if (!bindToken) return { ok: false, problem: "invalid_bind_token" } as const;
    const destination = parseCodeDestination(data.destination);
    if (!destination || !isSignInCode(data.code)) {
      return { ok: false, problem: "invalid_input" } as const;
    }
    const store = contactBindStore();
    if (!store) return { ok: false, problem: "unavailable" } as const;
    const signInConfig = await readSignInConfigOrNull(process.env);
    if (!signInConfig) return { ok: false, problem: "failed" } as const;
    const result = await bindAccountContact({
      db: requireDatabaseClient(),
      store,
      userId: context.user.id,
      bindToken,
      destination,
      passCode: data.code,
      config: signInConfig.config,
    });
    setResponseHeader(
      "set-cookie",
      contactBindEndingCookie(publicOrigin(request).startsWith("https:")),
    );
    return result.status === "bound"
      ? ({ ok: true, email: result.email, phone: result.phone } as const)
      : ({ ok: false, problem: result.status } as const);
  });
