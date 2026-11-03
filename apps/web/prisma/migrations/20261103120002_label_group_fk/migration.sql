SET lock_timeout = '5s';

ALTER TABLE "labels" ADD CONSTRAINT "labels_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "label_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

RESET lock_timeout;
