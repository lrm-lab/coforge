import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware } from "./function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { readSignInConfigOrNull } from "#src/server/auth/config.server";
import { clientAddress } from "#src/server/http/public-origin.server";
import { isNewPassword } from "#src/features/auth/new-password";
import { isSignInCode } from "#src/features/auth/code-destination";
import {
  sendAccountPasswordCode,
  setAccountPassword,
} from "#src/server/auth/account-password.server";

const contact = z.enum(["email", "phone"]);

export const requestAccountPasswordCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ contact }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    const signInConfig = await readSignInConfigOrNull(process.env);
    if (!signInConfig) return { ok: false, problem: "failed" } as const;
    const result = await sendAccountPasswordCode({
      db: requireDatabaseClient(),
      userId: context.user.id,
      contact: data.contact,
      config: signInConfig.config,
      clientAddress: clientAddress(getRequest()),
    });
    return result.status === "sent"
      ? ({ ok: true } as const)
      : ({ ok: false, problem: result.status } as const);
  });

export const setAccountPasswordFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ contact, code: z.string().trim().max(32), password: z.string().max(128) }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    if (!isSignInCode(data.code) || !isNewPassword(data.password)) {
      return { ok: false, problem: "invalid_input" } as const;
    }
    const signInConfig = await readSignInConfigOrNull(process.env);
    if (!signInConfig) return { ok: false, problem: "failed" } as const;
    const result = await setAccountPassword({
      db: requireDatabaseClient(),
      userId: context.user.id,
      contact: data.contact,
      passCode: data.code,
      newPassword: data.password,
      config: signInConfig.config,
      clientAddress: clientAddress(getRequest()),
    });
    if (result.status === "updated") return { ok: true, verified: true } as const;
    if (result.status === "updated_unverified") return { ok: true, verified: false } as const;
    return { ok: false, problem: result.status } as const;
  });
