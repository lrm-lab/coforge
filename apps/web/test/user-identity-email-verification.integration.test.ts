import { expect, test } from "bun:test";
import { UserIdentityRepository } from "#src/server/auth/user-identity.repository.server";
import { userIdentityFixture } from "./helpers/user-identity-fixture";

/**
 * `UserIdentityRepository.markEmailVerified` against local PostgreSQL — the write behind Authing's
 * `user:email-verified` webhook: it flips the flag once, a repeat is a no-op write, and a subject
 * no identity owns (or owns under another provider) marks nothing.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "the verified-email webhook marks the identity's user and nothing else",
  async () => {
    const { db, suffix, login, storedVerification, userWrites, teardown } =
      await userIdentityFixture();
    try {
      const user = await login(`sub-verify-${suffix}`, { email: `v-${suffix}@example.com` });
      expect((await storedVerification(user.id)).emailVerified).not.toBe(true);
      const repo = new UserIdentityRepository(db);

      expect(await repo.markEmailVerified("authing", `sub-verify-${suffix}`)).toBe(true);
      expect((await storedVerification(user.id)).emailVerified).toBe(true);

      const writes = userWrites().length;
      expect(await repo.markEmailVerified("authing", `sub-verify-${suffix}`)).toBe(true);
      expect(userWrites().length).toBe(writes);

      expect(await repo.markEmailVerified("authing", `sub-unknown-${suffix}`)).toBe(false);
      expect(await repo.markEmailVerified("github", `sub-verify-${suffix}`)).toBe(false);
    } finally {
      await teardown();
    }
  },
);
