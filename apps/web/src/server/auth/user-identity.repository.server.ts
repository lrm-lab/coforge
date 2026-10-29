import type { PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { initialDisplayName } from "#src/features/auth/name-prefill";
import { prismaUsernameAllocator, type UsernameProfile } from "./username-allocation.server";

export class UserIdentityRepository {
  private readonly usernames;

  constructor(private readonly db: PrismaClient) {
    this.usernames = prismaUsernameAllocator(db);
  }

  async resolve(provider: string, providerSubject: string, profile: UsernameProfile = {}) {
    // The provider's latest email and phone, and whether it vouches for each, are stored on every
    // login; none of them selects the User. A claim the provider stops reporting reads as
    // unverified, which is the safe direction: only a verified address may match an operator.
    const email = profile.email || undefined;
    const phone = profile.phone || undefined;
    const emailVerified = profile.emailVerified === true;
    const phoneVerified = profile.phoneVerified === true;
    const identity = await this.findIdentity(provider, providerSubject);
    if (identity) {
      const changed = {
        ...(email && identity.user.email !== email ? { email } : {}),
        ...(phone && identity.user.phone !== phone ? { phone } : {}),
        ...(identity.user.emailVerified !== emailVerified ? { emailVerified } : {}),
        ...(identity.user.phoneVerified !== phoneVerified ? { phoneVerified } : {}),
      };
      if (Object.keys(changed).length === 0) return identity.user;
      return this.db.user.update({ where: { id: identity.user.id }, data: changed });
    }
    const id = crypto.randomUUID();
    return this.usernames.create(profile, async (username) => {
      try {
        return await this.db.user.create({
          data: {
            id,
            username,
            // Every account has a name from the start, never its username; the person confirms
            // it at first sign-in (`welcomedAt`).
            displayName: initialDisplayName(profile),
            email,
            emailVerified,
            phone,
            phoneVerified,
            identities: { create: { provider, providerSubject } },
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The same person's other callback got here first: the identity is theirs, not a name
        // clash to retry. A name clash leaves no such identity and goes back to the allocator.
        const concurrent = await this.findIdentity(provider, providerSubject);
        if (concurrent) return concurrent.user;
        throw error;
      }
    });
  }

  private findIdentity(provider: string, providerSubject: string) {
    return this.db.userIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject } },
      include: { user: true },
    });
  }
}
