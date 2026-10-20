import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { resolveGitHubCommitTrailers } from "#src/server/integrations/github-commit-trailers.server";

const coAuthor = "CoForge <coforge@example.com>";
const configured = { COFORGE_COMMIT_COAUTHOR: coAuthor };
const expectedTrailer = `Co-authored-by: ${coAuthor}`;

const connectionString = Bun.env.GITHUB_COMMIT_TRAILERS_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("GITHUB_COMMIT_TRAILERS_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID();
let workspaceId = "";
let otherWorkspaceId = "";

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { slug: `trailers-${suffix}`, name: "Trailers" },
  });
  const otherWorkspace = await db.workspace.create({
    data: { slug: `trailers-other-${suffix}`, name: "Trailers other" },
  });
  workspaceId = workspace.id;
  otherWorkspaceId = otherWorkspace.id;
  await db.project.create({
    data: {
      workspaceId,
      slug: "bound-on",
      name: "Bound on",
      githubFullName: "acme/bound-on",
    },
  });
  await db.project.create({
    data: {
      workspaceId,
      slug: "bound-off",
      name: "Bound off",
      githubFullName: "acme/bound-off",
      commitCoAuthor: false,
    },
  });
  // Same repository bound in a different Workspace must never leak its toggle across Workspaces.
  await db.project.create({
    data: {
      workspaceId: otherWorkspaceId,
      slug: "bound-off-elsewhere",
      name: "Bound off elsewhere",
      githubFullName: "acme/unbound",
      commitCoAuthor: false,
    },
  });
});

afterAll(async () => {
  await db.project.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await db.$disconnect();
});

test("no configured co-author means no trailers for any repository, whatever the GitHub App env says", async () => {
  // The GitHub App's bot identity is no longer a co-author source: leftover App variables change nothing.
  const leftoverAppEnv = {
    COFORGE_GITHUB_APP_SLUG: "coforge-staging",
    COFORGE_GITHUB_APP_BOT_USER_ID: "328977087",
  };
  for (const env of [{}, leftoverAppEnv]) {
    expect(await resolveGitHubCommitTrailers(db, workspaceId, "acme/bound-on", env)).toEqual([]);
    expect(await resolveGitHubCommitTrailers(db, workspaceId, "acme/unbound", env)).toEqual([]);
    expect(await resolveGitHubCommitTrailers(db, workspaceId, null, env)).toEqual([]);
  }
});

test("a configured co-author follows the bound Project's toggle and defaults on otherwise", async () => {
  expect(await resolveGitHubCommitTrailers(db, workspaceId, "acme/bound-on", configured)).toEqual([
    expectedTrailer,
  ]);
  // Case-insensitive match against the stored `githubFullName`.
  expect(await resolveGitHubCommitTrailers(db, workspaceId, "ACME/Bound-On", configured)).toEqual([
    expectedTrailer,
  ]);
  expect(await resolveGitHubCommitTrailers(db, workspaceId, "acme/bound-off", configured)).toEqual(
    [],
  );
  expect(await resolveGitHubCommitTrailers(db, workspaceId, "ACME/BOUND-OFF", configured)).toEqual(
    [],
  );
  // Bound with the toggle off only in another Workspace: unbound here, so on.
  expect(await resolveGitHubCommitTrailers(db, workspaceId, "acme/unbound", configured)).toEqual([
    expectedTrailer,
  ]);
  expect(await resolveGitHubCommitTrailers(db, workspaceId, null, configured)).toEqual([
    expectedTrailer,
  ]);
});

test("an invalid co-author value is treated as unset", async () => {
  for (const value of [
    "",
    "CoForge",
    "CoForge <not-an-email>",
    "CoForge <a@b.co>\nSigned-off-by: x",
  ]) {
    const env = { COFORGE_COMMIT_COAUTHOR: value };
    expect(await resolveGitHubCommitTrailers(db, workspaceId, "acme/bound-on", env)).toEqual([]);
    expect(await resolveGitHubCommitTrailers(db, workspaceId, "acme/unbound", env)).toEqual([]);
    expect(await resolveGitHubCommitTrailers(db, workspaceId, null, env)).toEqual([]);
  }
});
