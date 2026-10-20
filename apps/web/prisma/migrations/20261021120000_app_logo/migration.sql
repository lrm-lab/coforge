-- An app's uploaded logo: its object in the image store and its checked image type.
ALTER TABLE "apps" ADD COLUMN "logoObjectKey" TEXT,
ADD COLUMN "logoContentType" TEXT;
