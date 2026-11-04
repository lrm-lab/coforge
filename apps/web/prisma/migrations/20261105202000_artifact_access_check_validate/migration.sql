-- task #529: the access CHECK added NOT VALID is proven here, one row scan under a short lock,
-- then it guards new writes like any other constraint.
SET lock_timeout = '5s';
ALTER TABLE "artifacts" VALIDATE CONSTRAINT "artifacts_access_check";
RESET lock_timeout;
