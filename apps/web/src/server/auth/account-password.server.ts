import type { CodeDestination } from "#src/features/auth/code-destination";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  createAuthingAuthentication,
  type AuthingAuthentication,
  type AuthingConfig,
} from "./authing-authentication.server";
import { reportSignInFailure, reportTokenRevocationFailure } from "./login-failure.server";
import {
  resetPasswordWithCode,
  sendPasswordResetCode,
  type ResetPasswordResult,
  type SendPasswordResetCodeResult,
} from "./password-reset.server";
import { getCodeSendRateLimits, getResetCodeRateLimits } from "./sign-in-rate-limits.server";

/** The contact addresses and verification flags currently stored on an account. */
export type AccountContact = {
  email: string | null;
  emailVerified: boolean | null;
  phone: string | null;
  phoneVerified: boolean | null;
};

/**
 * Resolves a requested contact to the same verified address already stored on the signed-in
 * account. Unverified addresses and caller-supplied destinations are never accepted.
 */
export function accountContactDestination(
  account: AccountContact,
  requested: "email" | "phone",
): CodeDestination | null {
  if (requested === "email") {
    if (account.emailVerified !== true) return null;
    const email = account.email?.trim().toLowerCase();
    return email ? { kind: "email", email } : null;
  }
  if (account.phoneVerified !== true) return null;
  const phone = account.phone?.trim();
  if (!phone || !/^\+86(1\d{10})$/.test(phone)) return null;
  return { kind: "phone", countryCode: "+86", phone: phone.slice(3) };
}

export async function sendAccountPasswordCode(input: {
  db: PrismaClient;
  userId: string;
  contact: "email" | "phone";
  config: AuthingConfig;
  clientAddress?: string;
  authing?: AuthingAuthentication;
}): Promise<SendPasswordResetCodeResult | { status: "no_contact" }> {
  const account = await input.db.user.findUnique({
    where: { id: input.userId },
    select: { email: true, emailVerified: true, phone: true, phoneVerified: true },
  });
  const destination = account && accountContactDestination(account, input.contact);
  if (!destination) return { status: "no_contact" };
  return sendPasswordResetCode({
    config: input.config,
    destination,
    rateLimits: getCodeSendRateLimits(),
    clientAddress: input.clientAddress,
    authing: input.authing,
  });
}

export type SetAccountPasswordResult =
  | ResetPasswordResult
  | { status: "updated_unverified" }
  | { status: "no_contact" }
  | { status: "identity_mismatch" };

export async function setAccountPassword(input: {
  db: PrismaClient;
  userId: string;
  contact: "email" | "phone";
  passCode: string;
  newPassword: string;
  config: AuthingConfig;
  clientAddress?: string;
  authing?: AuthingAuthentication;
}): Promise<SetAccountPasswordResult> {
  const account = await input.db.user.findUnique({
    where: { id: input.userId },
    select: {
      email: true,
      emailVerified: true,
      phone: true,
      phoneVerified: true,
      identities: {
        where: { provider: "authing" },
        select: { providerSubject: true },
        take: 1,
      },
    },
  });
  const destination = account && accountContactDestination(account, input.contact);
  if (!destination) return { status: "no_contact" };
  const expectedSub = account.identities[0]?.providerSubject;
  if (!expectedSub) return { status: "identity_mismatch" };

  const authing = input.authing ?? createAuthingAuthentication(input.config);
  const resetResult = await resetPasswordWithCode({
    config: input.config,
    destination,
    passCode: input.passCode,
    newPassword: input.newPassword,
    rateLimits: getResetCodeRateLimits(),
    clientAddress: input.clientAddress,
    authing,
  });
  if (resetResult.status !== "updated") return resetResult;

  // Verify the reset updated the signed-in user's own Authing account (`sub`), since `User.email`
  // and `User.phone` are not unique identity keys in CoForge.
  let accessToken: string | undefined;
  let profileSub: string;
  try {
    const tokens = await authing.signInWithPassword({
      account: destination.kind === "email" ? destination.email : destination.phone,
      password: input.newPassword,
      clientIp: input.clientAddress,
    });
    accessToken = tokens.accessToken;
    const profile = await authing.fetchUserInfo(tokens.accessToken);
    profileSub = profile.sub;
  } catch (error) {
    reportSignInFailure(error);
    return { status: "updated_unverified" };
  } finally {
    if (accessToken) {
      await authing.revokeToken(accessToken).catch(reportTokenRevocationFailure);
    }
  }
  if (profileSub !== expectedSub) {
    console.warn(JSON.stringify({ event: "auth.account_password_sub_mismatch" }));
    return { status: "identity_mismatch" };
  }
  return { status: "updated" };
}
