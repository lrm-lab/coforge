import { describe, expect, test } from "bun:test";
import {
  decideRedMainPush,
  evaluateMainCiRuns,
  parseGitHubRepo,
  type CiRunSummary,
} from "./main-ci-guard";

describe("parseGitHubRepo", () => {
  test("parses HTTPS and SSH GitHub remotes and ignores local paths", () => {
    expect(parseGitHubRepo("https://github.com/lrm-lab/coforge.git")).toEqual({
      owner: "lrm-lab",
      repo: "coforge",
    });
    expect(parseGitHubRepo("git@github.com:lrm-lab/coforge.git")).toEqual({
      owner: "lrm-lab",
      repo: "coforge",
    });
    expect(parseGitHubRepo("/tmp/origin.git")).toBeNull();
  });
});

describe("evaluateMainCiRuns", () => {
  const mkRun = (id: number, conclusion: string, sha = `sha-${id}`): CiRunSummary => ({
    id,
    head_sha: sha,
    conclusion,
    display_title: `commit ${id}`,
    html_url: `https://github.com/lrm-lab/coforge/actions/runs/${id}`,
  });

  test("returns green when latest non-cancelled run succeeded", () => {
    const status = evaluateMainCiRuns(
      [mkRun(3, "cancelled"), mkRun(2, "success"), mkRun(1, "failure")],
      [],
    );
    expect(status).toEqual({ state: "green" });
  });

  test("finds the first red commit across consecutive failures and lists failed jobs", () => {
    const status = evaluateMainCiRuns(
      [
        mkRun(4, "failure", "sha-latest"),
        mkRun(3, "failure", "sha-first-red"),
        mkRun(2, "success"),
      ],
      [
        { name: "Plan checks", conclusion: "success" },
        { name: "Validate Web 1/3", conclusion: "failure" },
        { name: "Validate Daemon 1/2", conclusion: "timed_out" },
      ],
    );
    expect(status.state).toBe("red");
    if (status.state !== "red") throw new Error("expected red");
    expect(status.firstRedRun.head_sha).toBe("sha-first-red");
    expect(status.failedJobs).toEqual(["Validate Web 1/3", "Validate Daemon 1/2"]);
  });

  test("returns green when only 0-step cancelled jobs and the CI passed aggregate job failed", () => {
    const status = evaluateMainCiRuns(
      [mkRun(4, "failure", "sha-cancelled")],
      [
        { name: "Plan checks", conclusion: "success" },
        { name: "Validate Web 1/3", conclusion: "success" },
        { name: "Check installer darwin-arm64", conclusion: "cancelled", steps: [] },
        { name: "CI passed", conclusion: "failure" },
      ],
    );
    expect(status).toEqual({ state: "green" });
  });

  test("stays red when a check job was cancelled after running steps", () => {
    const status = evaluateMainCiRuns(
      [mkRun(4, "failure", "sha-mid-cancel")],
      [
        { name: "Plan checks", conclusion: "success" },
        {
          name: "Validate Daemon 1/2",
          conclusion: "cancelled",
          steps: [{ name: "Run tests" }],
        },
        { name: "CI passed", conclusion: "failure" },
      ],
    );
    expect(status.state).toBe("red");
    if (status.state !== "red") throw new Error("expected red");
    expect(status.failedJobs).toEqual(["Validate Daemon 1/2"]);
  });

  test("excludes CI passed from failedJobs when a real check job failed", () => {
    const status = evaluateMainCiRuns(
      [mkRun(4, "failure", "sha-real-fail")],
      [
        { name: "Validate Web 1/3", conclusion: "failure" },
        { name: "CI passed", conclusion: "failure" },
      ],
    );
    expect(status.state).toBe("red");
    if (status.state !== "red") throw new Error("expected red");
    expect(status.failedJobs).toEqual(["Validate Web 1/3"]);
  });
});

describe("decideRedMainPush", () => {
  const redStatus = evaluateMainCiRuns(
    [
      {
        id: 10,
        head_sha: "deadbeef1234",
        conclusion: "failure",
        display_title: "feat: broke web",
        html_url: "https://github.com/lrm-lab/coforge/actions/runs/10",
      },
    ],
    [{ name: "Validate Web 1/3", conclusion: "failure" }],
  );

  test("rejects unrelated pushes when main is red, printing failed jobs and first red commit", () => {
    const decision = decideRedMainPush({
      status: redStatus,
      commitSubjects: ["feat(installer): tweak banner"],
      changedFiles: ["crates/installer/src/main.rs"],
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected rejection");
    expect(decision.message).toContain("Validate Web 1/3");
    expect(decision.message).toContain("deadbeef1234");
    expect(decision.message).toContain("[fix-ci]");
  });

  test("allows push when commit title carries a CI fix marker", () => {
    const decision = decideRedMainPush({
      status: redStatus,
      commitSubjects: ["fix(web): [fix-ci] restore check"],
      changedFiles: ["docs/notes.md"],
    });
    expect(decision.allowed).toBe(true);
  });

  test("allows push when changed files touch the failing job's scope", () => {
    const decision = decideRedMainPush({
      status: redStatus,
      commitSubjects: ["fix(web): update failing handler"],
      changedFiles: ["apps/web/src/server/auth/config.server.ts"],
    });
    expect(decision.allowed).toBe(true);
  });
});
