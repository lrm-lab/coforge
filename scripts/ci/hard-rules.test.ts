import { expect, test } from "bun:test";
import { useTestRepo } from "../git-hooks/test-repo";

// The Markdown link rule, the skills-lock exemption, whole-tree mode, and the pre-commit hook
// running both checks. hard-rules-diff.test.ts covers the rules judged on a diff.
const repo = useTestRepo();

const BROKEN_LINK_MESSAGE = "markdown-links";

test("a new Markdown file with a broken relative link is blocked, naming the file, line and fix", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "docs/guide.md": "# Guide\n\nSee [the setup](setup.md#install) first.\n" });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(BROKEN_LINK_MESSAGE);
  expect(result.stderr).toContain("docs/guide.md:3");
  expect(result.stderr).toContain("setup.md#install");
  expect(result.stderr).toContain("docs/setup.md");
  expect(result.stderr).toMatch(/fix:/i);
  expect(repo.ok("ls-tree", "-r", "--name-only", "HEAD")).toBe("README.md");
});

test("links to tracked files and directories, URLs, anchors, and links in code pass", () => {
  repo.seed({ "README.md": "# Repo\n", "docs/setup.md": "# Setup\n", "src/a.ts": "export {};\n" });
  repo.write({
    "docs/topic/guide.md": [
      "# Guide",
      "[setup](../setup.md#install) [query](../setup.md?plain=1) [root](/README.md)",
      "[dir](../../src) [dir slash](../../src/) [self](#guide) [web](https://example.com/x.md)",
      "[mail](mailto:someone@example.com) [angle](<../setup.md>) [titled](../setup.md 'Setup')",
      "![image](../../src/a.ts) [spaced](../setup.md%20)",
      "Inline code is not a link: `[x](missing-inline.md)`, ``[y](missing-double.md)``.",
      "```md",
      "[fenced](missing-fenced.md)",
      "```",
      "~~~~",
      "[tilde](missing-tilde.md)",
      "```",
      "~~~~",
      "",
    ].join("\n"),
  });

  const result = repo.commitAll();

  // `%20` decodes to a trailing space, which names no tracked file.
  expect(result.stderr).toContain("docs/topic/guide.md:5");
  expect(result.stderr).not.toContain("missing-");
  expect(result.stderr.match(new RegExp(BROKEN_LINK_MESSAGE, "g"))).toHaveLength(1);
  expect(result.stderr).not.toContain("docs/topic/guide.md:2");
  expect(result.stderr).not.toContain("docs/topic/guide.md:3");
  expect(result.stderr).not.toContain("docs/topic/guide.md:4");
});

test("a link passes once its target is committed in the same change", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "docs/guide.md": "[setup](setup.md)\n", "docs/setup.md": "# Setup\n" });

  const result = repo.commitAll();

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("a target that exists only in the working tree, not the index, is broken", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "docs/guide.md": "[setup](setup.md)\n" });
  repo.ok("add", "docs/guide.md");
  repo.write({ "docs/setup.md": "# Setup, untracked\n" });

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("docs/guide.md:1");
});

test("deleting a file that an unchanged Markdown file links to is blocked", () => {
  repo.seed({
    "docs/index.md": "# Index\n\n- [Setup](setup.md)\n- [Older](older.md)\n",
    "docs/setup.md": "# Setup\n",
  });
  repo.ok("rm", "-q", "docs/setup.md");

  const result = repo.commit();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("docs/index.md:3");
  expect(result.stderr).toContain("setup.md");
  // The file is not edited, so only links into what the change removes are its concern.
  expect(result.stderr).not.toContain("older.md");
});

test("renaming a linked file is blocked until the links follow it", () => {
  repo.seed({
    "README.md": "[setup](docs/setup.md) and [docs](docs)\n",
    "docs/setup.md": "# Setup\n",
  });
  repo.ok("mv", "docs/setup.md", "docs/install.md");

  const blocked = repo.commit();
  expect(blocked.exitCode).not.toBe(0);
  expect(blocked.stderr).toContain("README.md:1");
  expect(blocked.stderr).toContain("docs/setup.md");

  repo.write({ "README.md": "[setup](docs/install.md) and [docs](docs)\n" });
  const fixed = repo.commitAll();
  expect(fixed.stderr).toBe("");
  expect(fixed.exitCode).toBe(0);
});

test("an existing broken link in a Markdown file the change does not touch is not reported", () => {
  repo.seed({ "docs/old.md": "[gone](gone.md)\n" });
  repo.write({ "docs/new.md": "# New\n" });

  expect(repo.commitAll().exitCode).toBe(0);
});

test("range mode checks the Markdown a range changes and links its deletions break", () => {
  const base = repo.seed({ "docs/index.md": "[setup](setup.md)\n", "docs/setup.md": "# Setup\n" });
  repo.seed({ "docs/extra.md": "[index](index.md)\n" });
  expect(repo.range(base).exitCode).toBe(0);

  repo.ok("rm", "-q", "docs/setup.md");
  repo.seed({ "docs/new.md": "[nowhere](nowhere.md)\n" });

  const result = repo.range(base);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("docs/index.md:1");
  expect(result.stderr).toContain("docs/new.md:1");
  expect(result.stderr).not.toContain("docs/extra.md");
});

test("files in a skill directory registered in skills-lock.json are exempt; other skills are not", () => {
  const lock = { version: 1, skills: { "vendored-skill": { source: "upstream/skills" } } };
  repo.seed({ "skills-lock.json": JSON.stringify(lock), "README.md": "# Repo\n" });
  repo.write({
    ".agents/skills/vendored-skill/SKILL.md": "[upstream only](references/missing.md)\n",
    ".agents/skills/own-skill/SKILL.md": "[ours](references/missing.md)\n",
  });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(".agents/skills/own-skill/SKILL.md:1");
  expect(result.stderr).not.toContain("vendored-skill");
});

test("whole-tree mode reports every broken link in tracked Markdown", () => {
  repo.seed({ "docs/a.md": "[fine](b.md)\n", "docs/b.md": "\n[gone](gone.md)\n" });

  const result = repo.all();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("docs/b.md:2");
  expect(result.stderr).not.toContain("docs/a.md");
});

test("the hook reports the size ratchet and the other hard rules together", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "big.ts": "x".repeat(20_001), "docs/guide.md": "[gone](gone.md)\n" });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("big.ts: 5,001 tokens, new file over the limit");
  expect(result.stderr).toContain("docs/guide.md:1");
  expect(repo.ok("ls-tree", "-r", "--name-only", "HEAD")).toBe("README.md");
});

test("a clean commit passes silently", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "docs/guide.md": "[readme](../README.md)\n", "src/a.ts": "export const a = 1;\n" });

  const result = repo.commitAll();

  expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
});

test("range mode warns and passes when the base is not a commit", () => {
  repo.seed({ "docs/b.md": "[gone](gone.md)\n" });

  for (const base of ["", "0".repeat(40)]) {
    const result = repo.range(base);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "::warning::No base commit to diff from, so the hard rules were not checked.\n",
    );
  }
});

test("a later commit in the range cures a broken link the range added", () => {
  const base = repo.seed({ "README.md": "# Repo\n" });
  repo.seed({ "docs/a.md": "[gone](gone.md)\n" });
  expect(repo.range(base).exitCode).not.toBe(0);

  repo.seed({ "docs/a.md": "[readme](../README.md)\n" });

  expect(repo.range(base)).toMatchObject({ exitCode: 0, stderr: "" });
});

test("link destinations with balanced parentheses and reference definitions are checked", () => {
  repo.seed({ "docs/foo_(bar).md": "# Foo\n", "docs/setup.md": "# Setup\n" });
  repo.write({
    "docs/guide.md": [
      "[fine](foo_(bar).md) [broken](baz_(qux).md)",
      "[ref]: setup.md",
      '  [gone]: missing-ref.md "Title"',
      "[site]: https://example.com/missing.md",
      "[anchor]: #setup",
      "[^1]: A footnote, not missing.md.",
      "```",
      "[fenced]: missing-fenced.md",
      "```",
      "",
    ].join("\n"),
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("docs/guide.md:1: link baz_(qux).md names docs/baz_(qux).md");
  expect(result.stderr).toContain("docs/guide.md:3: link missing-ref.md");
  expect(result.stderr).toContain("markdown-links (2)");
});

test("a reference definition needs an empty rest or a title; fences in lists and quotes are code", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "docs/guide.md": [
      "[TODO]: decide this later",
      "[titled]: missing-titled.md (Title)",
      "- A list item:",
      "",
      "    ```md",
      "    [listed](missing-listed.md)",
      "    ```",
      "> ```md",
      "> [quoted](missing-quoted.md)",
      "> ```",
      "[after](missing-after.md)",
      "",
    ].join("\n"),
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("markdown-links (2)");
  expect(result.stderr).toContain("docs/guide.md:2: link missing-titled.md");
  expect(result.stderr).toContain("docs/guide.md:11: link missing-after.md");
});

test("an inline-code line of backticks is no fence; comments, footnotes, outside links work", () => {
  repo.seed({ "README.md": "# Repo\n", "notes.md": "# Notes\n" });
  repo.write({
    "docs/a.md": [
      "```bash``` runs first.",
      "[after code](missing-after-code.md)",
      "<!-- [hidden](missing-hidden.md) --> [same line](missing-same-line.md)",
      "<!--",
      "[hidden too](missing-hidden-too.md)",
      "--> [after comment](missing-after-comment.md)",
      "[^1]: notes.md",
      "[out](../../outside.md)",
      "",
    ].join("\n"),
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("markdown-links (4)");
  expect(result.stderr).toContain("docs/a.md:2: link missing-after-code.md");
  expect(result.stderr).toContain("docs/a.md:3: link missing-same-line.md");
  expect(result.stderr).toContain("docs/a.md:6: link missing-after-comment.md");
  expect(result.stderr).toContain("docs/a.md:8: link ../../outside.md names ../outside.md");
});

test("a range whose base and head share no history is reported in one line, with exit 2", () => {
  const base = repo.seed({ "README.md": "# Repo\n" });
  repo.ok("switch", "-q", "--orphan", "other");
  repo.seed({ "other.md": "# Other\n" });

  const result = repo.check(["--range", base, "HEAD"], { GITHUB_ACTIONS: "true" });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toStartWith("::error::hard-rules: ");
  expect(result.stderr).toContain("no merge base");
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
});

test("a mid-line <!-- is literal, escaped brackets are no link, and .markdown files are checked", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "docs/a.md": [
      "the <!-- marker is literal",
      "[later](missing-later.md)",
      "\\[x\\](missing-escaped.md)",
      "",
    ].join("\n"),
    "docs/b.markdown": "[gone](missing-markdown.md)\n",
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("markdown-links (2)");
  expect(result.stderr).toContain("docs/a.md:2: link missing-later.md");
  expect(result.stderr).toContain("docs/b.markdown:1: link missing-markdown.md");
});
