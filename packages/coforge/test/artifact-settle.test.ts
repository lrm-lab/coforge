import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArtifactArgs, runArtifact } from "#src/artifact-commands";
import { formatArtifactList, formatArtifactRead } from "#src/artifact-format";
import { CliError } from "#src/cli-error";
import { fakeServer, ID } from "./artifact-directory-fixture";

let root: string;
let previousHoldFile: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coforge-artifact-settle-"));
  previousHoldFile = Bun.env.COFORGE_ARTIFACT_HOLD_FILE;
  Bun.env.COFORGE_ARTIFACT_HOLD_FILE = join(root, "holds.json");
});

afterEach(async () => {
  if (previousHoldFile === undefined) delete Bun.env.COFORGE_ARTIFACT_HOLD_FILE;
  else Bun.env.COFORGE_ARTIFACT_HOLD_FILE = previousHoldFile;
  await rm(root, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected CliError");
}

test("artifact settle and unsettle parse arguments and format settled, idempotent, and working states", async () => {
  expect(parseArtifactArgs(["settle", ID])).toEqual({
    command: "artifact",
    request: { operation: "settle", artifact: ID },
  });
  expect(parseArtifactArgs(["unsettle", ID, "--json"])).toEqual({
    command: "artifact",
    request: { operation: "unsettle", artifact: ID },
    json: true,
  });
  expect(() => parseArtifactArgs(["settle"])).toThrow("Name the artifact");

  const settledPayload = {
    artifact: {
      id: ID,
      name: "launch-plan",
      title: "Launch Plan",
      currentVersion: 3,
      settled: {
        at: "2026-11-27T10:00:00.000Z",
        version: 3,
        by: { kind: "agent", name: "writer" },
      },
      reopened: null,
    },
    changed: true,
    newlyFollowing: true,
  };
  const settledText = (await runArtifact(parseArtifactArgs(["settle", ID]), {
    artifact: async () => settledPayload,
  })) as string;
  expect(settledText).toContain('Settled "Launch Plan" at v3.');
  expect(settledText).toContain(`coforge artifact unfollow ${ID}`);

  const alreadySettledText = (await runArtifact(parseArtifactArgs(["settle", ID]), {
    artifact: async () => ({ ...settledPayload, changed: false, newlyFollowing: undefined }),
  })) as string;
  expect(alreadySettledText).toBe(
    '"Launch Plan" was settled already by @writer on 2026-11-27 at v3: nothing changed.',
  );

  const unsettledText = (await runArtifact(parseArtifactArgs(["unsettle", ID]), {
    artifact: async () => ({
      artifact: { ...settledPayload.artifact, settled: null },
      changed: true,
    }),
  })) as string;
  expect(unsettledText).toBe('"Launch Plan" is Working again.');

  const alreadyWorkingText = (await runArtifact(parseArtifactArgs(["unsettle", ID]), {
    artifact: async () => ({
      artifact: { ...settledPayload.artifact, settled: null },
      changed: false,
    }),
  })) as string;
  expect(alreadyWorkingText).toBe('"Launch Plan" is Working already: nothing changed.');
});

test("formatArtifactRead and formatArtifactList render settled and reopened status", () => {
  const settled = {
    at: "2026-11-27T10:00:00.000Z",
    version: 3,
    by: { kind: "user", name: "alice" },
  };
  const settledRead = formatArtifactRead(
    {
      artifact: { id: ID, title: "Launch Plan", currentVersion: 3, settled, reopened: null },
      version: { number: 3 },
      text: "# Launch",
    },
    true,
  );
  expect(settledRead).toContain(
    "Settled: @alice settled it on 2026-11-27 at v3. A new version takes it back to Working.",
  );

  const reopenedRead = formatArtifactRead(
    {
      artifact: {
        id: ID,
        title: "Launch Plan",
        currentVersion: 4,
        settled: null,
        reopened: { version: 4, was: settled },
      },
      version: { number: 4 },
      text: "# Launch v4",
    },
    true,
  );
  expect(reopenedRead).toContain("Working again: v4 came after @alice settled v3 on 2026-11-27.");

  const listed = formatArtifactList([
    {
      id: ID,
      name: "launch-plan",
      title: "Launch Plan",
      currentVersion: 3,
      updatedAt: "2026-11-27T10:00:00.000Z",
      settled,
    },
  ]);
  expect(listed).toContain("[settled]");
});

test("artifact push holds once locally for non-page directories and proceeds on retry", async () => {
  const server = fakeServer({ "data.csv": "a,b\n1,2\n" });
  const dir = join(root, "csv-only");
  await mkdir(dir);
  await writeFile(join(dir, "data.csv"), "a,b\n1,2\n");

  const missingTitle = await failure(
    runArtifact(parseArtifactArgs(["push", dir, "--target", "#eng"]), server.transport),
  );
  expect(missingTitle.code).toBe("INVALID_ARG");

  const held = await failure(
    runArtifact(
      parseArtifactArgs(["push", dir, "--target", "#eng", "--title", "Metrics"]),
      server.transport,
    ),
  );
  expect(held.code).toBe("ARTIFACT_NOT_A_PAGE");
  expect(held.message).toContain("data.csv");
  expect(held.suggestedNextAction).toContain("coforge attachment upload");
  expect(server.requests).toHaveLength(0);

  const created = (await runArtifact(
    parseArtifactArgs(["push", dir, "--target", "#eng", "--title", "Metrics"]),
    server.transport,
  )) as string;
  expect(created).toContain("Created artifact");
  expect(server.requests.length).toBeGreaterThan(0);

  await writeFile(join(dir, "data.csv"), "a,b\n1,3\n");
  const updated = (await runArtifact(parseArtifactArgs(["push", dir]), server.transport)) as string;
  expect(updated).toContain("Pushed version");
});
