import { requireDatabaseClient } from "../src/server/db/client.server";
import { backfillArtifactOrigins } from "../src/server/conversations/artifact-origin-backfill.server";

const argv = Bun.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const numberFlag = (name: string, min = 1) => {
  const value = flag(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min)
    throw new Error(`${name} must be an integer of at least ${min}, got ${value}`);
  return parsed;
};
const uuidFlag = (name: string) => {
  const value = flag(name);
  if (value === undefined) return undefined;
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`${name} must be a uuid, got ${value}`);
  return value;
};
if (!argv.includes("--dry-run") && !argv.includes("--apply"))
  throw new Error(
    "usage: --dry-run | --apply [--from-message-id <uuid>] [--workspace-id <uuid>] [--scan-window <n>] [--batch-size <n>] [--max-minutes <n>] [--pause-ms <n>]",
  );

const db = requireDatabaseClient();
try {
  const summary = await backfillArtifactOrigins(db, {
    dryRun: argv.includes("--dry-run"),
    fromMessageId: uuidFlag("--from-message-id"),
    workspaceId: uuidFlag("--workspace-id"),
    scanWindow: numberFlag("--scan-window"),
    batchSize: numberFlag("--batch-size"),
    maxMinutes: numberFlag("--max-minutes"),
    pauseMs: numberFlag("--pause-ms", 0),
  });
  console.log(
    JSON.stringify({
      event: "artifact_origin_backfill",
      dryRun: argv.includes("--dry-run"),
      ...summary,
      resume: summary.finished ? undefined : `--from-message-id ${summary.cursor}`,
    }),
  );
} finally {
  await db.$disconnect();
}
