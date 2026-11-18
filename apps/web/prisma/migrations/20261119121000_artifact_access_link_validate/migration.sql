-- task #artifacts:#27: the widened access CHECK is proven here, one row scan under a short lock.
SET lock_timeout = '5s';
ALTER TABLE "artifacts" VALIDATE CONSTRAINT "artifacts_access_check";
RESET lock_timeout;
