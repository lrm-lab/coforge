-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "imageHeight" INTEGER,
ADD COLUMN     "imageWidth" INTEGER;

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_image_dimensions_pair"
CHECK (
  ("imageWidth" IS NULL AND "imageHeight" IS NULL)
  OR (
    "imageWidth" IS NOT NULL AND "imageHeight" IS NOT NULL
    AND "imageWidth" > 0 AND "imageHeight" > 0
  )
) NOT VALID;
