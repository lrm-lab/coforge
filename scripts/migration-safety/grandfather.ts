// Migrations at or before this directory name were merged before the migration safety check
// existed and are never judged, by the hard rule or the deploy gate. It is the last directory of
// apps/web/prisma/migrations on origin/main when the check was introduced; the cutoff is a name,
// not a commit, so a rebase or squash does not move it. Never raise it to excuse a new migration.
export const LAST_GRANDFATHERED_MIGRATION = "20261030170000_machine_status";

export const isGrandfathered = (directoryName: string): boolean =>
  directoryName <= LAST_GRANDFATHERED_MIGRATION;
