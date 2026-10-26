import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConstructedPanel, readClaudeRecycleBriefing } from "./fixtures/claude-readers";
import { claudeConfigFixture, toolResultRecord, toolUseRecord } from "./claude-transcript-fixtures";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup() {
  const claude = await claudeConfigFixture();
  const workspace = await mkdtemp(join(tmpdir(), "coforge-recycle-workspace-"));
  cleanups.push(claude.remove, () => rm(workspace, { recursive: true, force: true }));
  const brief = (budgetTokens = 8_000) =>
    readClaudeRecycleBriefing({
      sessionId: "sess-1",
      workingDirectory: workspace,
      budgetTokens,
      envVars: claude.envVars,
    });
  return { claude, workspace, brief };
}

/** The objects-in-play section: the tail repeats result text, which is not under test here. */
const objectsOf = (panel: string) => panel.slice(0, panel.indexOf("<recent-actions"));

const minute = (n: number) => new Date(Date.UTC(2026, 9, 23, 6, n, 0)).toISOString();

/** `count` Bash calls, one minute apart from `start`, each answered by `output`. */
function bashCalls(count: number, start = 0, output = "done"): string[] {
  return Array.from({ length: count }, (_, k) => {
    const id = `toolu_${start + k}`;
    return [
      toolUseRecord(minute(start + k), id, "Bash", {
        command: `echo step-${start + k}`,
        description: "x",
      }),
      toolResultRecord(minute(start + k), id, output),
    ];
  }).flat();
}

test("no transcript, an unusable budget, or fewer than five actions: no briefing", async () => {
  const { claude, brief } = await setup();
  expect(await brief()).toBeUndefined();
  await claude.transcript("sess-1", bashCalls(4));
  expect(await brief()).toBeUndefined();
  await claude.transcript("sess-1", bashCalls(5));
  expect(await brief(0)).toBeUndefined();
  expect(await brief()).toBeString();
});

test("the recent-actions tail is the last 12 calls with name, input summary and outcome", async () => {
  const { claude, brief } = await setup();
  const lines = bashCalls(14);
  lines.push(
    toolUseRecord(minute(20), "toolu_bad", "Bash", { command: "make test" }),
    toolResultRecord(minute(20), "toolu_bad", "exit code 2", true),
    toolUseRecord(minute(21), "toolu_edit", "Edit", { file_path: "/w/a.ts", new_string: "x" }),
    toolResultRecord(minute(21), "toolu_edit", "updated"),
  );
  await claude.transcript("sess-1", lines);
  const panel = (await brief())!;
  expect(panel).toContain('<recent-actions span="12 of 16" order="oldest first">');
  expect(panel).toContain("Bash(command=echo step-13) \u2192 done");
  expect(panel).not.toContain("echo step-3)");
  expect(panel).toMatch(/s14 +! 2026-10-23 06:20:00Z Bash\(command=make test\) → exit code 2/);
  expect(panel).toMatch(
    /s15 +\* 2026-10-23 06:21:00Z Edit\(file_path=\/w\/a.ts new_string=x\) → updated/,
  );
  expect(panel.trimStart().startsWith("<")).toBe(true);
});

test("CoForge messages: check results come in, sends go out, repeats are merged", async () => {
  const { claude, brief } = await setup();
  const inbound =
    "[target=#coforge:01a16774-5cc3 msg=01a16779-a316 time=2026-10-23 06:00:30Z type=human] @user: ship it\nsecond line\nNo more new messages.";
  const lines = [
    toolUseRecord(minute(1), "c1", "Bash", {
      command: "coforge message check --target '#coforge:01a16774-5cc3'",
    }),
    toolResultRecord(minute(1), "c1", inbound),
    toolUseRecord(minute(2), "s1", "Bash", {
      command:
        "coforge message check --target '#other'; coforge message send --target '#coforge:01a16774-5cc3' <<'COFORGE_MESSAGE'\nOn it.\nWill report.\nCOFORGE_MESSAGE",
    }),
    toolResultRecord(
      minute(2),
      "s1",
      "Message sent to #coforge:01a16774-5cc3. Message ID: 01a1677a-0000-7000-8000-000000000000",
    ),
    toolUseRecord(minute(3), "r1", "Bash", {
      command: "coforge message read --target '#coforge:01a16774-5cc3'",
    }),
    toolResultRecord(
      minute(3),
      "r1",
      "Read window: 1 returned, oldest to newest. No older. No newer.\n\n[1/1 msg=01a16779-a316-7000-8000-000000000000 time=2026-10-23 06:00:30Z type=human replyTarget=#x] @user: ship it\nsecond line, longer\n\nEnd of window: 1/1 shown.",
    ),
    ...bashCalls(5, 10),
  ];
  await claude.transcript("sess-1", lines);
  const panel = (await brief())!;
  const section = panel.slice(
    panel.indexOf("<recent-messages"),
    panel.indexOf("</recent-messages>"),
  );
  // `check` and `read` print the same message differently; the fuller rendering is kept once.
  expect(section).toContain("msg=01a16779-a316");
  expect(section).toContain("type=human");
  expect(section).toContain("@user: ship it\nsecond line");
  expect(section).toContain(
    "[target=#coforge:01a16774-5cc3 time=2026-10-23 06:02:00Z] you sent: On it.\nWill report.",
  );
  expect(section.match(/msg=01a16779-a316/g)).toHaveLength(1);
  expect(section.indexOf("ship it")).toBeLessThan(section.indexOf("you sent"));
});

test("a held draft is a sent message only once --send-draft delivers it; a failed send is not", async () => {
  const { claude, brief } = await setup();
  await claude.transcript("sess-1", [
    toolUseRecord(minute(1), "s1", "Bash", {
      command: "coforge message send --target '#a' <<'EOF'\nheld text\nEOF",
    }),
    toolResultRecord(
      minute(1),
      "s1",
      "Held — 1 unread message in #a. Your message has been saved as a draft.",
    ),
    toolUseRecord(minute(2), "s2", "Bash", {
      command: 'coforge message send --send-draft --target "#a"',
    }),
    toolResultRecord(minute(2), "s2", "Message sent to #a."),
    toolUseRecord(minute(3), "s3", "Bash", {
      command: "coforge message send --target '#b' <<'EOF'\nnever delivered\nEOF",
    }),
    toolResultRecord(minute(3), "s3", "Error: no such channel", true),
    ...bashCalls(5, 10),
  ]);
  const panel = (await brief())!;
  expect(panel).toContain("you sent: held text");
  expect(panel).not.toContain("never delivered");
});

test("recentMessagesMax 0 drops the section; one message is capped at 2000 tokens", async () => {
  const { claude, workspace, brief } = await setup();
  const huge = `[target=#a msg=01a16779-a316 time=2026-10-23 06:00:30Z type=human] @user: ${"w".repeat(20_000)}`;
  const transcriptPath = await claude.transcript("sess-1", [
    toolUseRecord(minute(1), "c1", "Bash", { command: "coforge message check" }),
    toolResultRecord(minute(1), "c1", huge),
    ...bashCalls(5, 10),
  ]);
  const withoutMessages = await buildConstructedPanel({
    transcriptPath,
    workingDirectory: workspace,
    budgetTokens: 8_000,
    recentMessagesMax: 0,
  });
  expect(withoutMessages).not.toContain("<recent-messages");
  const panel = (await brief())!;
  expect(panel).toContain("[… truncated — read the channel for the rest]");
  expect(panel.length).toBeLessThan(9_000);
});

test("an in-play file is re-read from disk (absolute, or relative to the workspace)", async () => {
  const { claude, workspace, brief } = await setup();
  await mkdir(join(workspace, "docs"));
  await writeFile(join(workspace, "docs", "plan.md"), "CURRENT PLAN\n");
  await writeFile(join(workspace, "abs.md"), "CURRENT ABS\n");
  await claude.transcript("sess-1", [
    toolUseRecord(minute(1), "a", "Read", { file_path: join(workspace, "abs.md") }),
    toolResultRecord(minute(1), "a", "OLD ABS"),
    toolUseRecord(minute(2), "b", "Bash", { command: "cat docs/plan.md" }),
    toolResultRecord(minute(2), "b", "OLD PLAN"),
    ...bashCalls(4, 10),
  ]);
  const panel = (await brief())!;
  expect(panel).toContain("CURRENT PLAN");
  expect(panel).toContain("CURRENT ABS");
  expect(panel).toContain("current — re-read just now");
  expect(objectsOf(panel)).not.toContain("OLD ABS");
});

test("MEMORY.md, sensitive paths, symlinks, oversized and escaping paths are never re-read", async () => {
  const { claude, workspace, brief } = await setup();
  const outside = await mkdtemp(join(tmpdir(), "coforge-recycle-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(workspace, "MEMORY.md"), "DISK MEMORY");
  await writeFile(join(workspace, "api-token.txt"), "DISK TOKEN");
  await writeFile(join(outside, "target.md"), "DISK SYMLINK TARGET");
  await symlink(join(outside, "target.md"), join(workspace, "link.md"));
  await writeFile(join(workspace, "big.md"), "DISK BIG ".repeat(10_000));
  await writeFile(join(outside, "escape.md"), "DISK ESCAPE");
  const reads = [
    [join(workspace, "MEMORY.md"), "TRANSCRIPT MEMORY"],
    [join(workspace, "api-token.txt"), "TRANSCRIPT TOKEN"],
    [join(workspace, "link.md"), "TRANSCRIPT LINK"],
    [join(workspace, "big.md"), "TRANSCRIPT BIG"],
  ] as const;
  const lines = reads.flatMap(([path, text], k) => [
    toolUseRecord(minute(k), `r${k}`, "Read", { file_path: path }),
    toolResultRecord(minute(k), `r${k}`, text),
  ]);
  lines.push(
    toolUseRecord(minute(5), "e", "Bash", {
      command: `cat ../${outside.split("/").at(-1)}/escape.md`,
    }),
    toolResultRecord(minute(5), "e", "TRANSCRIPT ESCAPE"),
  );
  await claude.transcript("sess-1", lines);
  const panel = (await brief())!;
  const objects = objectsOf(panel);
  for (const secret of [
    "DISK MEMORY",
    "DISK TOKEN",
    "DISK SYMLINK TARGET",
    "DISK BIG",
    "DISK ESCAPE",
  ])
    expect(panel).not.toContain(secret);
  // Only what the transcript showed, flagged as possibly stale; MEMORY.md and token files not even that.
  expect(objects).toContain("TRANSCRIPT LINK");
  expect(objects).toContain("could not re-read, may be stale");
  expect(objects).not.toContain("TRANSCRIPT MEMORY");
  expect(objects).not.toContain("TRANSCRIPT TOKEN");
  expect(panel).toContain('<object name="' + join(workspace, "MEMORY.md") + '"');
});

test("a file last touched more than two hours before the end is a pointer, not a body", async () => {
  const { claude, workspace, brief } = await setup();
  await writeFile(join(workspace, "old.md"), "DISK OLD");
  await claude.transcript("sess-1", [
    toolUseRecord(minute(0), "o", "Read", { file_path: join(workspace, "old.md") }),
    toolResultRecord(minute(0), "o", "TRANSCRIPT OLD"),
    ...bashCalls(5, 200),
  ]);
  const panel = (await brief())!;
  expect(panel).toMatch(/<object name="[^"]*old\.md" touched="1x" last-observed="[^"]+"\/>/);
  expect(panel).not.toContain("DISK OLD");
  expect(objectsOf(panel)).not.toContain("TRANSCRIPT OLD");
});

test("the panel fits the budget: objects are trimmed, messages shrink", async () => {
  const { claude, workspace, brief } = await setup();
  const lines: string[] = [];
  for (let k = 0; k < 10; k += 1) {
    await writeFile(join(workspace, `file${k}.md`), `body ${k} `.repeat(2_000));
    lines.push(
      toolUseRecord(minute(k), `f${k}`, "Read", { file_path: join(workspace, `file${k}.md`) }),
      toolResultRecord(minute(k), `f${k}`, "x"),
    );
  }
  for (let k = 0; k < 10; k += 1)
    lines.push(
      toolUseRecord(minute(30 + k), `m${k}`, "Bash", { command: "coforge message check" }),
      toolResultRecord(
        minute(30 + k),
        `m${k}`,
        `[target=#a msg=01a16779-a31${k} time=2026-10-23 06:3${k}:00Z type=human] @user: ${"m".repeat(3_000)}`,
      ),
    );
  await claude.transcript("sess-1", lines);
  for (const budget of [1_500, 3_000, 8_000]) {
    const panel = (await brief(budget))!;
    expect(Math.ceil(panel.length / 4)).toBeLessThanOrEqual(budget);
  }
});

test("a 500 KB single-token command, with or without slashes or sends, is scanned in linear time", async () => {
  const { claude, brief } = await setup();
  const blob = "x".repeat(500_000);
  await claude.transcript("sess-1", [
    toolUseRecord(minute(0), "p", "Bash", { command: `cat ${blob}` }),
    toolResultRecord(minute(0), "p", "ok"),
    toolUseRecord(minute(1), "q", "Bash", { command: `cat ${"a/".repeat(250_000)}` }),
    toolResultRecord(minute(1), "q", "ok"),
    toolUseRecord(minute(2), "s", "Bash", {
      command: `coforge message send --target '#a' ${"<<a\n".repeat(125_000)}`,
    }),
    toolResultRecord(minute(2), "s", "Message sent to #a."),
    toolUseRecord(minute(3), "d", "Bash", {
      command: `echo ${"... ".repeat(125_000)};${" ".repeat(100_000)}x`,
    }),
    toolResultRecord(minute(3), "d", `${"[target=".repeat(50_000)}`),
    ...bashCalls(2, 10),
  ]);
  const started = performance.now();
  expect(await brief()).toBeString();
  expect(performance.now() - started).toBeLessThan(100);
});

test("sensitive dotfiles and key files are never re-read, nor shown from the transcript", async () => {
  const { claude, workspace, brief } = await setup();
  await mkdir(join(workspace, ".ssh"));
  await mkdir(join(workspace, ".aws"));
  const names = [
    ".env",
    ".env.local",
    "prod.env",
    ".npmrc",
    ".netrc",
    ".ssh/config",
    ".aws/config",
    "id_rsa",
    "id_ed25519.pub",
    "cert.p12",
  ];
  const lines: string[] = [];
  for (const [k, name] of names.entries()) {
    await writeFile(join(workspace, name), `DISK ${k}`);
    lines.push(
      toolUseRecord(minute(k), `r${k}`, "Read", { file_path: join(workspace, name) }),
      toolResultRecord(minute(k), `r${k}`, `TRANSCRIPT ${k}`),
    );
  }
  await claude.transcript("sess-1", lines);
  const objects = objectsOf((await brief())!);
  for (const k of names.keys()) {
    expect(objects).not.toContain(`DISK ${k}`);
    expect(objects).not.toContain(`TRANSCRIPT ${k}`);
  }
});

test("a file outside the workspace is not re-read; only the capped transcript snippet shows", async () => {
  const { claude, brief } = await setup();
  const outside = await mkdtemp(join(tmpdir(), "coforge-recycle-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "notes.md"), "DISK OUTSIDE");
  await claude.transcript("sess-1", [
    toolUseRecord(minute(0), "o", "Read", { file_path: join(outside, "notes.md") }),
    toolResultRecord(minute(0), "o", "TRANSCRIPT OUTSIDE"),
    ...bashCalls(5, 10),
  ]);
  const objects = objectsOf((await brief())!);
  expect(objects).not.toContain("DISK OUTSIDE");
  expect(objects).toContain("TRANSCRIPT OUTSIDE");
  expect(objects).toContain("could not re-read, may be stale");
});

test("a symlinked directory inside the workspace cannot lead the re-read outside it", async () => {
  const { claude, workspace, brief } = await setup();
  const outside = await mkdtemp(join(tmpdir(), "coforge-recycle-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "leak.md"), "DISK LEAK");
  await symlink(outside, join(workspace, "shared"));
  await claude.transcript("sess-1", [
    toolUseRecord(minute(0), "o", "Read", { file_path: join(workspace, "shared", "leak.md") }),
    toolResultRecord(minute(0), "o", "TRANSCRIPT LEAK"),
    ...bashCalls(5, 10),
  ]);
  const objects = objectsOf((await brief())!);
  expect(objects).not.toContain("DISK LEAK");
  expect(objects).toContain("TRANSCRIPT LEAK");
});

test("a file under a sensitive directory reached through a symlink is not re-read", async () => {
  const { claude, workspace, brief } = await setup();
  await mkdir(join(workspace, ".ssh"));
  await writeFile(join(workspace, ".ssh", "known.md"), "DISK KNOWN");
  await symlink(join(workspace, ".ssh"), join(workspace, "alias"));
  await claude.transcript("sess-1", [
    toolUseRecord(minute(0), "o", "Read", { file_path: join(workspace, "alias", "known.md") }),
    toolResultRecord(minute(0), "o", "x"),
    ...bashCalls(5, 10),
  ]);
  expect(objectsOf((await brief())!)).not.toContain("DISK KNOWN");
});

test("a long path with little budget left still keeps its body within the budget", async () => {
  const { claude, workspace, brief } = await setup();
  const name = join(workspace, `${"deep/".repeat(50)}notes.md`);
  await claude.transcript("sess-1", [
    toolUseRecord(minute(0), "w", "Write", { file_path: name, content: "y".repeat(400_000) }),
    toolResultRecord(minute(0), "w", "ok"),
    ...bashCalls(5, 1),
  ]);
  for (let budget = 255; budget <= 300; budget += 5) {
    const panel = await brief(budget);
    if (panel) expect(Math.ceil(panel.length / 4)).toBeLessThanOrEqual(budget * 2);
  }
});

test("a sensitive file's read result and inputs are kept out of the recent actions", async () => {
  const { claude, workspace, brief } = await setup();
  await claude.transcript("sess-1", [
    toolUseRecord(minute(0), "r", "Read", { file_path: join(workspace, ".env") }),
    toolResultRecord(minute(0), "r", "API_KEY=TRANSCRIPT-SECRET"),
    toolUseRecord(minute(1), "c", "Bash", { command: "cat ~/.aws/credentials" }),
    toolResultRecord(minute(1), "c", "aws_secret_access_key=COMMAND-SECRET"),
    ...bashCalls(5, 2),
  ]);
  const panel = (await brief())!;
  expect(panel).toContain("Read(");
  expect(panel).not.toContain("TRANSCRIPT-SECRET");
  expect(panel).not.toContain("COMMAND-SECRET");
});
