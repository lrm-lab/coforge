import { expect, test } from "bun:test";

import { checkReleaseHealth, coveringRun, type WorkflowRun } from "./release-health";

const REPO = "lrm-lab/coforge";
const TOKEN = "test-token";
// Commits are ordered hex numbers so the fake ancestry is `a <= b`.
const sha = (n: number) => n.toString(16).padStart(40, "0");
const COMMIT = sha(4);

const run = (id: number, head: number, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  head_sha: sha(head),
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: `2026-11-0${id}T00:00:00Z`,
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  ...over,
});

/** Answers the three endpoints the script calls; `runs` maps a workflow file to its list. */
function api(runs: Record<string, WorkflowRun[]>) {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    const file = url.pathname.split("/workflows/")[1]?.split("/")[0] ?? "";
    const body = runs[file];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify({ workflow_runs: body }));
  };
  return { fetchImpl: fetchImpl as typeof fetch, requested };
}

const isAncestor = (a: string, b: string) => parseInt(a, 16) <= parseInt(b, 16);
const green = { webE2e: [run(90, 9)], webIntegration: [run(91, 9, { conclusion: "failure" })] };

const options = (over: Record<string, unknown> = {}) => ({
  repo: REPO,
  token: TOKEN,
  commit: COMMIT,
  fetchImpl: api(green).fetchImpl,
  isAncestor,
  ...over,
});

test("coveringRun picks the earliest main run whose head descends from the commit", () => {
  const runs = [
    run(3, 9), // newest tip, descends
    run(2, 5), // the push that carried the commit, descends
    run(1, 3), // before the commit, does not descend
    run(4, 7), // descends but newer than run 2
  ];
  // created_at order in the fixture is id order; run 4 was created after run 2.
  const covering = coveringRun(runs, COMMIT, isAncestor);
  expect(covering?.id).toBe(2);
});

test("a commit that was a push tip is covered by its own run", () => {
  const covering = coveringRun([run(1, 4), run(2, 3)], COMMIT, isAncestor);
  expect(covering?.id).toBe(1);
});

test("a green covering run passes and the suites' conclusions reach the summary", async () => {
  const { fetchImpl } = api({
    "ci.yml": [run(1, 9), run(2, 5)],
    "web-e2e.yml": green.webE2e,
    "web-integration.yml": green.webIntegration,
  });
  const result = await checkReleaseHealth(options({ fetchImpl }));
  expect(result.ok).toBe(true);
  expect(result.verdict).toBe("green");
  const summary = result.summary.join("\n");
  expect(summary).toContain("success");
  expect(summary).toContain("web-e2e.yml");
  expect(summary).toContain("web-integration.yml");
  expect(summary).toContain("failure");
});

test("a red covering run refuses the release", async () => {
  const { fetchImpl } = api({
    "ci.yml": [run(1, 5, { conclusion: "failure" })],
    "web-e2e.yml": [],
    "web-integration.yml": [],
  });
  const result = await checkReleaseHealth(options({ fetchImpl }));
  expect(result.ok).toBe(false);
  expect(result.verdict).toBe("red");
  expect(result.detail).toContain("failure");
});

test("allow-red with a reason passes a red verdict and announces the bypass", async () => {
  const { fetchImpl } = api({
    "ci.yml": [run(1, 5, { conclusion: "failure" })],
    "web-e2e.yml": [],
    "web-integration.yml": [],
  });
  const result = await checkReleaseHealth(
    options({ fetchImpl, allowRed: true, reason: "docs-only hotfix approved by Frank" }),
  );
  expect(result.ok).toBe(true);
  expect(result.warnings.length).toBe(1);
  expect(result.warnings[0]).toContain("docs-only hotfix approved by Frank");
  expect(result.summary.join("\n")).toContain("Bypass");
});

test("allow-red without a reason is an error, not a bypass", async () => {
  const { fetchImpl } = api({
    "ci.yml": [run(1, 5, { conclusion: "failure" })],
    "web-e2e.yml": [],
    "web-integration.yml": [],
  });
  const result = await checkReleaseHealth(options({ fetchImpl, allowRed: true, reason: "  " }));
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("ci_override_reason");
});

test("a covering run still in progress refuses the release", async () => {
  const { fetchImpl } = api({
    "ci.yml": [run(1, 5, { status: "in_progress", conclusion: null })],
    "web-e2e.yml": [],
    "web-integration.yml": [],
  });
  const result = await checkReleaseHealth(options({ fetchImpl }));
  expect(result.ok).toBe(false);
  expect(result.verdict).toBe("running");
});

test("a commit no scanned run covers passes with a note", async () => {
  const { fetchImpl } = api({
    "ci.yml": [run(1, 3)], // head 3 is older than commit 4: nothing descends
    "web-e2e.yml": [],
    "web-integration.yml": [],
  });
  const result = await checkReleaseHealth(options({ fetchImpl }));
  expect(result.ok).toBe(true);
  expect(result.verdict).toBe("none");
});

test("without --commit the script only reports the suites", async () => {
  const { fetchImpl, requested } = api({
    "web-e2e.yml": green.webE2e,
    "web-integration.yml": green.webIntegration,
  });
  const result = await checkReleaseHealth({ repo: REPO, token: TOKEN, fetchImpl });
  expect(result.ok).toBe(true);
  expect(result.commitChecked).toBe(false);
  expect(requested.some((u) => u.includes("ci.yml"))).toBe(false);
});

test("a suite that cannot be read is reported unavailable, never fatal", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.includes("web-e2e")) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ workflow_runs: [] }));
  }) as typeof fetch;
  const result = await checkReleaseHealth({ repo: REPO, token: TOKEN, fetchImpl });
  expect(result.ok).toBe(true);
  expect(result.summary.join("\n")).toContain("unavailable");
});

test("a malformed commit is rejected before any API call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  await expect(checkReleaseHealth(options({ fetchImpl, commit: "not-a-sha" }))).rejects.toThrow(
    /40/,
  );
  expect(called).toBe(false);
});
