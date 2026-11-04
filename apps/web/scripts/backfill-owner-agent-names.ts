import { requireDatabaseClient } from "../src/server/db/client.server";
import { backfillOwnerAgentNames } from "../src/server/agents/owner-agent-rename.server";

/**
 * One-time backfill for task #495: rewrite owner-named assistants whose stored name is an
 * auto-name (the current rule's in any language, the pre-#495 weekly-report rule's, or the bare
 * generic name) to the current rule's name for the owner's current label and language.
 * Hand-chosen names are left alone.
 *
 *   --dry-run  writes nothing; prints the count and samples
 *   --apply    writes
 *   --backup   writes nothing; prints every agent's id and displayName as JSONL (one per line),
 *              so an operator can save the state before an apply and restore from it
 *
 * Exactly one mode is required.
 */
function usage(): never {
  throw new Error("usage: --dry-run | --apply | --backup");
}

const argv = Bun.argv.slice(2);
const modes = ["--dry-run", "--apply", "--backup"].filter((flag) => argv.includes(flag));
if (modes.length !== 1) usage();
const mode = modes[0]!;

const db = requireDatabaseClient();
try {
  if (mode === "--backup") {
    for (const agent of await db.agent.findMany({ select: { id: true, displayName: true } }))
      console.log(JSON.stringify(agent));
  } else {
    const summary = await backfillOwnerAgentNames({ db, dryRun: mode === "--dry-run" });
    console.log(
      JSON.stringify({
        event: "owner_agent_name_backfill",
        dryRun: mode === "--dry-run",
        ...summary,
      }),
    );
  }
} finally {
  await db.$disconnect();
}
