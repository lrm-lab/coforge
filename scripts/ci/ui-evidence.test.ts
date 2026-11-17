import { describe, expect, test } from "bun:test";
import { useTestRepo } from "../git-hooks/test-repo";
import {
  isUiFilePath,
  requiresUiEvidenceTitle,
  uiEvidenceExemptReason,
  uiEvidenceIssues,
} from "./ui-evidence";

const repo = useTestRepo();

const VALID_EVIDENCE = [
  "UI-Evidence:",
  "- screenshots: 134-compare.jpg (01a1e85e-f9ad-7000-8000-000000000001)",
  "- themes-viewports: light, dark, phone (390px)",
  "- break-ui: tested long CJK labels, +128 overflow and keyboard focus rings; badge expands cleanly",
].join("\n");

describe("isUiFilePath", () => {
  test("matches rendered UI components, routes and stylesheets under apps/web/src", () => {
    for (const path of [
      "apps/web/src/features/conversations/conversation-row.tsx",
      "apps/web/src/components/layout/phone-shell.tsx",
      "apps/web/src/routes/w.$workspaceSlug/activity.tsx",
      "apps/web/src/styles/coforge-theme.css",
      "apps/web/src/styles.css",
    ]) {
      expect({ path, ui: isUiFilePath(path) }).toEqual({ path, ui: true });
    }
  });

  test("skips server modules, server functions, API routes, generated files, tests and non-UI ts", () => {
    for (const path of [
      "apps/web/src/server/conversations/channel-directory.server.ts",
      "apps/web/src/features/conversations/channels.functions.ts",
      "apps/web/src/features/conversations/channel-function-scope.server.ts",
      "apps/web/src/features/conversations/conversation-unread.ts",
      "apps/web/src/routes/api/me.ts",
      "apps/web/src/routeTree.gen.ts",
      "apps/web/src/generated/prisma/client.ts",
      "apps/web/src/paraglide/messages.js",
      "apps/web/src/client.tsx",
      "apps/web/src/router.tsx",
      "apps/web/src/styles/coforge-theme.test.ts",
      "apps/web/src/features/conversations/row.test.tsx",
      "apps/web/test/channel-header-people.test.tsx",
      "apps/web/src/features/AGENTS.md",
      "packages/daemon/src/index.ts",
    ]) {
      expect({ path, ui: isUiFilePath(path) }).toEqual({ path, ui: false });
    }
  });
});

describe("requiresUiEvidenceTitle", () => {
  test("requires evidence on feat and fix commits only", () => {
    for (const title of [
      "feat: add unread thread capsule",
      "feat(web): add unread thread capsule",
      "fix(artifacts)!: align header avatar ring",
    ]) {
      expect({ title, required: requiresUiEvidenceTitle(title) }).toEqual({
        title,
        required: true,
      });
    }

    for (const title of [
      "refactor(web): extract conversation badge parts",
      "test(web): cover header overflow pill",
      "docs: document ui-delivery skill",
      "chore(web): remove unused styles",
      "perf(web): memoize channel row",
      "fixup! feat(web): add unread thread capsule",
      'Revert "feat(web): add unread thread capsule"',
      "Merge branch 'main' into feat/x",
    ]) {
      expect({ title, required: requiresUiEvidenceTitle(title) }).toEqual({
        title,
        required: false,
      });
    }
  });
});

describe("uiEvidenceIssues", () => {
  test("accepts a complete UI-Evidence block with screenshot, light, dark, phone and break-ui", () => {
    const message = `feat(web): add badge\n\n${VALID_EVIDENCE}\n\nRevert-effect: loses badge\n`;
    expect(uiEvidenceIssues(message)).toEqual([]);
  });

  test("accepts URLs or attachment UUIDs as screenshot evidence and 390px as phone evidence", () => {
    const message = [
      "fix(web): tighten spacing",
      "",
      "UI-Evidence:",
      "- screenshots: https://example.com/before-after.png",
      "- verified: light + dark + 390x844",
      "- break-ui: verified narrow flex truncation and focus ring visibility",
      "",
      "Revert-effect: restores loose spacing",
    ].join("\n");
    expect(uiEvidenceIssues(message)).toEqual([]);
  });

  test("reports every missing piece when UI-Evidence is absent or incomplete", () => {
    expect(uiEvidenceIssues("feat(web): add badge\n\nRevert-effect: none\n")).toEqual([
      "no UI-Evidence section",
    ]);

    const incomplete = [
      "fix(web): tweak color",
      "",
      "UI-Evidence:",
      "- screenshots: none",
      "- themes: light only",
      "- break-ui: todo",
      "",
      "Revert-effect: reverts color",
    ].join("\n");
    expect(uiEvidenceIssues(incomplete)).toEqual([
      "missing screenshot attachment or link",
      "missing dark theme check",
      "missing phone (390px) check",
      "missing break-ui conclusion",
    ]);
  });

  test("accepts UI-Evidence: exempt — <reason> with a real reason and rejects empty or placeholder reasons", () => {
    const valid = [
      "fix(web): fix aria-label typo",
      "",
      "UI-Evidence: exempt — single aria-label typo fix with zero visual delta",
      "",
      "Revert-effect: restores typo",
    ].join("\n");
    expect(uiEvidenceExemptReason(valid)).toBe("single aria-label typo fix with zero visual delta");
    expect(uiEvidenceIssues(valid)).toEqual([]);

    for (const bad of [
      "fix(web): tweak\n\nUI-Evidence: exempt\n\nRevert-effect: none\n",
      "fix(web): tweak\n\nUI-Evidence: exempt — \n\nRevert-effect: none\n",
      "fix(web): tweak\n\nUI-Evidence: exempt — none\n\nRevert-effect: none\n",
      "fix(web): tweak\n\nUI-Evidence: exempt: skip\n\nRevert-effect: none\n",
    ]) {
      expect(uiEvidenceExemptReason(bad)).toBeUndefined();
      expect(uiEvidenceIssues(bad)).toEqual([
        "exempt requires a non-empty reason (UI-Evidence: exempt — <reason>)",
      ]);
    }
  });
});

describe("git hooks and hard-rules integration", () => {
  const uiFiles = {
    "apps/web/src/features/AGENTS.md": "- `features/demo/` — demo.\n",
    "apps/web/src/features/demo/card.tsx": "export function Card() {\n  return <div />;\n}\n",
  };

  test("blocks a feat or fix commit touching UI files without UI-Evidence in commit-msg and --range", () => {
    const base = repo.seed({
      "apps/web/src/features/AGENTS.md": "- `features/demo/` — demo.\n",
      "apps/web/src/features/demo/card.tsx": "export const Card = () => null;\n",
    });
    repo.write(uiFiles);
    repo.ok("add", "-A");

    const commitAttempt = repo.run([
      "git",
      "commit",
      "-q",
      "-m",
      "feat(web): render demo card",
      "-m",
      "Revert-effect: demo card disappears",
    ]);
    expect(commitAttempt.exitCode).not.toBe(0);
    expect(commitAttempt.stderr).toContain("UI-Evidence");

    repo.ok(
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "feat(web): render demo card",
      "-m",
      "Revert-effect: demo card disappears",
    );
    const rangeAttempt = repo.range(base, repo.head());
    expect(rangeAttempt.exitCode).not.toBe(0);
    expect(rangeAttempt.stderr).toContain("Blocked by hard rule ui-evidence");
    expect(rangeAttempt.stderr).toContain(
      "touches UI files (apps/web/src/features/demo/card.tsx) without a UI-Evidence section",
    );
  });

  test("blocks incomplete UI-Evidence naming each missing check", () => {
    const base = repo.seed(uiFiles);
    repo.write({
      "apps/web/src/styles/coforge-theme.css": ":root { --demo: 1; }\n",
    });
    repo.ok("add", "-A");
    repo.ok(
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "fix(web): adjust theme token",
      "-m",
      "UI-Evidence:\n- screenshots: compare.jpg\n- themes: light",
      "-m",
      "Revert-effect: reverts token",
    );

    const rangeAttempt = repo.range(base, repo.head());
    expect(rangeAttempt.exitCode).not.toBe(0);
    expect(rangeAttempt.stderr).toContain("ui-evidence");
    expect(rangeAttempt.stderr).toContain("missing dark theme check");
    expect(rangeAttempt.stderr).toContain("missing phone (390px) check");
    expect(rangeAttempt.stderr).toContain("missing break-ui conclusion");
  });

  test("passes when feat or fix carries complete UI-Evidence", () => {
    const base = repo.seed({
      "apps/web/src/features/AGENTS.md": "- `features/demo/` — demo.\n",
    });
    repo.write(uiFiles);
    repo.ok("add", "-A");

    const committed = repo.run([
      "git",
      "commit",
      "-q",
      "-m",
      "feat(web): render demo card",
      "-m",
      VALID_EVIDENCE,
      "-m",
      "Revert-effect: demo card disappears",
    ]);
    expect(committed.stderr).toBe("");
    expect(committed.exitCode).toBe(0);

    const rangeResult = repo.range(base, repo.head());
    expect(rangeResult.stderr).toBe("");
    expect(rangeResult.exitCode).toBe(0);
  });

  test("exempts pure refactor and test commits touching UI files", () => {
    const base = repo.seed(uiFiles);

    repo.write({
      "apps/web/src/features/demo/card.tsx": "export function Card() {\n  return <section />;\n}\n",
    });
    repo.ok("add", "-A");
    expect(
      repo.run([
        "git",
        "commit",
        "-q",
        "-m",
        "refactor(web): switch wrapper tag",
        "-m",
        "Revert-effect: none",
      ]).exitCode,
    ).toBe(0);

    repo.write({
      "apps/web/src/features/demo/card.test.tsx": "export const tested = true;\n",
    });
    repo.ok("add", "-A");
    expect(
      repo.run([
        "git",
        "commit",
        "-q",
        "-m",
        "test(web): add demo test",
        "-m",
        "Revert-effect: none",
      ]).exitCode,
    ).toBe(0);

    const rangeResult = repo.range(base, repo.head());
    expect(rangeResult.stderr).toBe("");
    expect(rangeResult.exitCode).toBe(0);
  });

  test("exempts server-only feat and fix commits under apps/web/src", () => {
    const base = repo.seed(uiFiles);
    repo.write({
      "apps/web/src/server/AGENTS.md": "- `server/demo/` — demo.\n",
      "apps/web/src/server/demo/service.server.ts": "export const ok = true;\n",
    });
    repo.ok("add", "-A");
    expect(
      repo.run([
        "git",
        "commit",
        "-q",
        "-m",
        "feat(web): add demo server module",
        "-m",
        "Revert-effect: removes server module",
      ]).exitCode,
    ).toBe(0);

    const rangeResult = repo.range(base, repo.head());
    expect(rangeResult.stderr).toBe("");
    expect(rangeResult.exitCode).toBe(0);
  });

  test("ignores pure deletion of an unimported UI file when no UI file is added or modified", () => {
    const base = repo.seed({
      "apps/web/src/features/AGENTS.md": "- `features/demo/` — demo.\n",
      "apps/web/src/features/demo/keep.ts": "export const keep = 1;\n",
      "apps/web/src/features/demo/unused.tsx": "export const Unused = () => null;\n",
    });
    repo.ok("rm", "-q", "apps/web/src/features/demo/unused.tsx");
    expect(
      repo.run([
        "git",
        "commit",
        "-q",
        "-m",
        "fix(web): delete dead unused component",
        "-m",
        "Revert-effect: none",
      ]).exitCode,
    ).toBe(0);
    expect(repo.range(base, repo.head())).toMatchObject({ exitCode: 0, stderr: "" });
  });

  test("allows UI-Evidence: exempt — <reason> and prints a visible warning in --range", () => {
    const base = repo.seed(uiFiles);
    repo.write({
      "apps/web/src/features/demo/card.tsx":
        'export function Card() {\n  return <div aria-label="Card" />;\n}\n',
    });
    repo.ok("add", "-A");
    const committed = repo.run([
      "git",
      "commit",
      "-q",
      "-m",
      "fix(web): add card accessible label",
      "-m",
      "UI-Evidence: exempt — urgent hotfix from Frank session with no visual layout delta",
      "-m",
      "Revert-effect: drops card aria-label",
    ]);
    expect(committed.exitCode).toBe(0);
    expect(committed.stderr).toContain("UI-Evidence exempt:");

    const rangeResult = repo.range(base, repo.head());
    expect(rangeResult.exitCode).toBe(0);
    expect(rangeResult.stderr).toBe("");
    expect(rangeResult.stdout).toContain("::warning::UI-Evidence exemptions used:");
    expect(rangeResult.stdout).toContain(
      "urgent hotfix from Frank session with no visual layout delta",
    );
  });

  test("only checks commits after --authors-since so pre-existing main commits without UI-Evidence do not fail", () => {
    const lastGreenMain = repo.seed(uiFiles);
    // Simulate an older commit already on main before this push, lacking UI-Evidence:
    repo.write({
      "apps/web/src/features/demo/card.tsx": "export function Card() {\n  return <span />;\n}\n",
    });
    repo.ok("add", "-A");
    repo.ok(
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "feat(web): legacy main commit before UI-Evidence gate",
      "-m",
      "Revert-effect: reverts legacy card",
    );
    const beforePushMain = repo.head();

    // Now push a new compliant commit on top of beforePushMain:
    repo.write({
      "apps/web/src/features/demo/card.tsx": "export function Card() {\n  return <article />;\n}\n",
    });
    repo.ok("add", "-A");
    repo.ok(
      "commit",
      "-q",
      "-m",
      "feat(web): compliant card update",
      "-m",
      VALID_EVIDENCE,
      "-m",
      "Revert-effect: reverts article tag",
    );

    const pushRangeResult = repo.range(
      lastGreenMain,
      repo.head(),
      "--authors-since",
      beforePushMain,
    );
    expect(pushRangeResult.stderr).toBe("");
    expect(pushRangeResult.exitCode).toBe(0);
  });
});
