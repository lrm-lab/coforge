SET lock_timeout = '5s';
ALTER TABLE "team_memory_entries" ADD CONSTRAINT "team_memory_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
RESET lock_timeout;
