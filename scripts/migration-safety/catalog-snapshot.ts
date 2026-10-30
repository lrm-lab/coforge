// Prints the catalog snapshot (snapshot.ts) of the database in DATABASE_URL as JSON on stdout.
// It runs on the deploy host inside the `migrate` container (scripts/deploy/catalog-snapshot.sh):
//   bun migration-safety/catalog-snapshot.ts <staging|production>
// Only table names, estimated row counts and sizes are read.
import { liveSnapshot } from "./catalog-query";

const environment = process.argv[2];
const url = process.env.DATABASE_URL;
if (!environment || !url) {
  console.error("usage: DATABASE_URL=... bun catalog-snapshot.ts <environment>");
  process.exit(2);
}
console.log(JSON.stringify(await liveSnapshot(url, environment, new Date()), null, 2));
