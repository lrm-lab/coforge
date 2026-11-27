import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Step, parse } from "./workflow-helpers";

const production = await parse("deploy-production.yml");
const sourceStep = (production.jobs.candidate.steps as Step[]).find(
  ({ id }) => id === "find_staging",
)!;

test("promotion resolves the checker tag from the healthy staging record's source commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-staging-promotion-"));
  try {
    const output = join(directory, "output");
    const summary = join(directory, "summary");
    const image = `ghcr.io/lrm-lab/coforge/coforge-web@sha256:${"b".repeat(64)}`;
    const candidateSha = "c".repeat(40);
    const record = { artifact_identity: image, outcome: "healthy", source_commit: candidateSha };
    const records = join(directory, "records");
    await mkdir(records);
    const fixtures = [
      [{ ...record, source_commit: `${candidateSha}\nother=untrusted` }],
      [{ ...record, outcome: "rolled-back" }],
      [record],
    ];
    for (const [index, rows] of fixtures.entries()) {
      await Bun.write(
        join(records, `${index + 10}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join("\n"),
      );
    }
    const gh = join(directory, "gh");
    await Bun.write(
      gh,
      `#!/bin/bash
case "$2" in
  list) printf '%s\\n' 10 11 12 ;;
  download) mkdir -p "$9" && cp "$RECORDS/$3.jsonl" "$9/deployment-records.jsonl" ;;
  view) printf '%s\\n' '${"a".repeat(40)}' ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(gh, 0o755);
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", sourceStep.run!], {
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        RECORDS: records,
        TMPDIR: directory,
        IMAGE: image,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: "lrm-lab/coforge",
        GITHUB_SERVER_URL: "https://github.com",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(output).text()).toBe(`staging_sha=${candidateSha}\n`);
    expect(await Bun.file(summary).text()).toContain("/actions/runs/12");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
