-- An app needs only a name: its homepage may be left out.
ALTER TABLE "apps" ALTER COLUMN "homepageUrl" DROP NOT NULL;
