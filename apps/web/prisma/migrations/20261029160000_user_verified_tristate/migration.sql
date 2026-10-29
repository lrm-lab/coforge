ALTER TABLE "users" ALTER COLUMN "emailVerified" DROP NOT NULL,
ALTER COLUMN "emailVerified" DROP DEFAULT,
ALTER COLUMN "phoneVerified" DROP NOT NULL,
ALTER COLUMN "phoneVerified" DROP DEFAULT;

-- Nothing was known about an account before this column existed: an address is "not yet reported"
-- until that person signs in again.
UPDATE "users" SET "emailVerified" = NULL, "phoneVerified" = NULL;
