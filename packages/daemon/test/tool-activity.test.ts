import { expect, test } from "bun:test";
import { toolActivityLabel } from "@lrm/coforge-sdk/internal";
import { toolActivity } from "#src/code-agent/tool-activity";

test("provider tool aliases retain known file and command semantics without exposing content", () => {
  for (const name of ["read", "Read", "ReadFile", "file_read", "read_file"])
    expect(toolActivity(name, { path: "src/a.ts", content: "private contents" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Reading file…",
      entries: [{ kind: "tool_start", toolName: "read_file", toolInput: "src/a.ts" }],
    });
  for (const name of ["write", "Write", "WriteFile", "file_write", "write_file"])
    expect(
      toolActivity(name, { file_path: "src/a.ts", content: "private contents" }),
    ).toMatchObject({
      detailKind: "tool_started",
      detail: "Writing file…",
      entries: [{ kind: "tool_start", toolName: "write_file", toolInput: "src/a.ts" }],
    });
  for (const name of [
    "edit",
    "Edit",
    "EditFile",
    "edit_file",
    "file_change",
    "StrReplaceFile",
    "apply_patch",
  ])
    expect(toolActivity(name, { path: "src/a.ts", patch: "private diff" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Editing file…",
      entries: [{ kind: "tool_start", toolName: "edit_file", toolInput: "src/a.ts" }],
    });
  for (const name of [
    "bash",
    "Bash",
    "shell",
    "Shell",
    "command_execution",
    "run_shell_command",
    "run_terminal_command",
  ])
    expect(toolActivity(name, { command: "pwd" })).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "pwd" }],
    });
});

test("unrecognized tools never infer file edits from arguments or emit prompts and patches", () => {
  expect(
    toolActivity("vendor__Mystery", {
      path: "secret/path",
      command: "secret command",
      prompt: "secret prompt",
      password: "hunter2",
    }),
  ).toMatchObject({
    detailKind: "tool_started",
    detail: "Using vendor__Mystery…",
    entries: [{ kind: "tool_start", toolName: "vendor__Mystery" }],
  });
  // A recognized tool missing its allowlisted field falls back to its generic label
  // (never the raw provider name or any other argument) and carries no toolInput.
  const missingField = toolActivity("apply_patch", { input: "*** private patch body ***" });
  expect(missingField).toMatchObject({
    detailKind: "tool_started",
    detail: "Editing file…",
    entries: [{ kind: "tool_start", toolName: "edit_file" }],
  });
  expect(missingField.entries[0]).not.toHaveProperty("toolInput");
});

test("an unrecognized tool's generic label is built from its name alone, never from arguments", () => {
  expect(toolActivity("vendor__Mystery", {})).toMatchObject({
    detail: toolActivityLabel("vendor__Mystery"),
  });
  const longName = "a_very_long_and_unrecognized_tool_identifier";
  expect(toolActivity(longName, {})).toMatchObject({ detail: toolActivityLabel(longName) });
  expect(toolActivityLabel(longName)).toBe(`Using ${longName.slice(0, 20)}……`);
});

test("new aliases resolve to their canonical tool and an allowlisted toolInput summary", () => {
  for (const name of ["Glob", "glob", "search_files"])
    expect(toolActivity(name, { pattern: "**/*.ts", secret: "no" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Searching files…",
      entries: [{ kind: "tool_start", toolName: "glob", toolInput: "**/*.ts" }],
    });
  for (const name of ["Grep", "grep"])
    expect(toolActivity(name, { query: "TODO" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Searching code…",
      entries: [{ kind: "tool_start", toolName: "grep", toolInput: "TODO" }],
    });
  for (const name of ["WebFetch", "web_fetch", "fetch_url", "FetchURL"])
    expect(
      toolActivity(name, { url: "https://example.com/doc", headers: { Authorization: "secret" } }),
    ).toMatchObject({
      detailKind: "tool_started",
      detail: "Fetching web…",
      entries: [
        { kind: "tool_start", toolName: "web_fetch", toolInput: "https://example.com/doc" },
      ],
    });
  for (const name of ["WebSearch", "web_search"])
    expect(toolActivity(name, { query: "coforge activity redaction" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Searching web…",
      entries: [
        { kind: "tool_start", toolName: "web_search", toolInput: "coforge activity redaction" },
      ],
    });
  for (const name of ["TodoWrite", "todo_write"]) {
    const result = toolActivity(name, { todos: [{ content: "private plan" }] });
    expect(result).toMatchObject({
      detailKind: "tool_started",
      detail: "Updating tasks…",
      entries: [{ kind: "tool_start", toolName: "todo_write" }],
    });
    expect(result.entries[0]).not.toHaveProperty("toolInput");
  }
});

test("file_path, pattern and url toolInput summaries are truncated and never fall back to the wrong field", () => {
  expect(toolActivity("read_file", { file_path: "a".repeat(250) })).toMatchObject({
    entries: [{ toolInput: "a".repeat(200) }],
  });
  expect(toolActivity("grep", { pattern: "p".repeat(150) })).toMatchObject({
    entries: [{ toolInput: "p".repeat(120) }],
  });
  expect(toolActivity("web_fetch", { url: "https://" + "x".repeat(250) })).toMatchObject({
    entries: [{ toolInput: ("https://" + "x".repeat(250)).slice(0, 200) }],
  });
  // Non-string values never leak into the toolInput, and the entry carries none.
  const nested = toolActivity("read_file", { file_path: { nested: "value" } });
  expect(nested).toMatchObject({ detail: "Reading file…" });
  expect(nested.entries[0]).not.toHaveProperty("toolInput");
});

test("non-CoForge bash commands: detail is always the generic label, toolInput is redacted and cut to 100 Unicode characters plus an ellipsis", () => {
  const secretCommand =
    'curl -H "Authorization: Bearer sk-liveTESTsecretTOKEN123" --data "password=hunter2" https://example.com';
  const result = toolActivity("bash", { command: secretCommand });
  expect(result.detailKind).toBe("running_command");
  expect(result.detail).toBe("Running command…");
  const toolInput = result.entries[0]!.toolInput!;
  expect(toolInput).not.toContain("sk-liveTESTsecretTOKEN123");
  expect(toolInput).not.toContain("hunter2");
  expect(toolInput).toContain("Bearer [REDACTED]");
  expect(toolInput).toContain("password=[REDACTED]");
  expect(JSON.stringify(result)).not.toContain("hunter2");
  expect(JSON.stringify(result)).not.toContain("sk-liveTESTsecretTOKEN123");

  const long = "echo " + "a".repeat(300);
  const truncated = toolActivity("bash", { command: long });
  expect(truncated.detail).toBe("Running command…");
  const truncatedInput = truncated.entries[0]!.toolInput!;
  expect(truncatedInput).toBe(`${long.slice(0, 100)}…`);
  const exact = "echo " + "a".repeat(95);
  expect(toolActivity("bash", { command: exact }).entries[0]!.toolInput).toBe(exact);

  // An inline script's opening is visible, so a `cat <<'EOF'` no longer collapses to `cat `.
  // Redaction is best-effort and now covers the heredoc body: the credential-shaped values are
  // still replaced, while prose the rules cannot recognise is reported.
  const heredocCommand = `cat <<'EOF'\nprivate body with password=hunter2\nEOF`;
  const heredocResult = toolActivity("bash", { command: heredocCommand });
  expect(heredocResult.detail).toBe("Running command…");
  const heredocInput = heredocResult.entries[0]!.toolInput!;
  expect(heredocInput).toContain("cat <<'EOF'");
  expect(heredocInput).toContain("private body");
  expect(heredocInput).toContain("password=[REDACTED]");
  expect(JSON.stringify(heredocResult)).not.toContain("hunter2");
});

test("bash truncation budgets Unicode code points, never splitting surrogate pairs", () => {
  const command = `echo ${"😀".repeat(300)}`;
  const result = toolActivity("bash", { command });
  const toolInput = result.entries[0]!.toolInput!;
  expect(toolInput).toBe(`echo ${"😀".repeat(95)}…`);
  expect([...toolInput].join("")).toBe(toolInput);
});

test("a multi-line bash command with no heredoc is sanitized to a single-line toolInput", () => {
  const command = ["if [ -f a.txt ]; then", "  echo start", "  echo password=hunter2", "fi"].join(
    "\n",
  );
  const result = toolActivity("bash", { command });
  expect(result.detailKind).toBe("running_command");
  expect(result.detail).toBe("Running command…");
  const toolInput = result.entries[0]!.toolInput!;
  // No control character (including newline) reaches the wire: validToolInput
  // (packages/coforge-sdk/src/internal/activity-entries.ts) rejects one outright.
  expect(/[\x00-\x1f\x7f]/.test(toolInput)).toBe(false);
  expect(toolInput).not.toContain("\n");
  expect([...toolInput].length).toBeLessThanOrEqual(200);
  expect(toolInput).toContain("password=[REDACTED]");
  expect(toolInput).not.toContain("hunter2");
});

test("CoForge CLI invocations resolve to the reference client's semantic tools and summaries, never the raw command", () => {
  // The closed set and the summary formats follow the reference Computer 1.0.47
  // (`resolveRaftCliInvocation` and `summarizeToolInput`); the five channel tools it leaves
  // unlabeled get a label and their channel here. `detail` is pinned as literal
  // text: computing it with `toolActivityLabel` would not notice a name missing from the
  // label vocabulary, which is how `Using update_reminder…` reached the UI.
  const cases: {
    command: string;
    detailKind: string;
    detail: string;
    toolName: string;
    toolInput?: string;
  }[] = [
    {
      command: "coforge message send --target @bob",
      detailKind: "tool_started",
      detail: "Sending message…",
      toolName: "send_message",
      toolInput: "@bob",
    },
    {
      command: "coforge message check",
      detailKind: "checking_messages",
      detail: "Checking messages…",
      toolName: "check_messages",
    },
    {
      command: "coforge message check --target #general",
      detailKind: "checking_messages",
      detail: "Checking messages…",
      toolName: "check_messages",
    },
    {
      command: "coforge message read --target @alice --limit 20",
      detailKind: "tool_started",
      detail: "Reading history…",
      toolName: "read_history",
      toolInput: "@alice",
    },
    {
      command: "coforge message search --query hello --target #general",
      detailKind: "tool_started",
      detail: "Searching messages…",
      toolName: "search_messages",
      toolInput: "hello",
    },
    {
      command: "coforge channel members #general",
      detailKind: "tool_started",
      detail: "Listing channel members…",
      toolName: "list_channel_members",
      toolInput: "#general",
    },
    {
      command: "coforge channel update --target #general --name renamed",
      detailKind: "tool_started",
      detail: "Updating channel…",
      toolName: "update_channel",
      toolInput: "#general",
    },
    {
      command: "coforge channel lifecycle archive --target #general",
      detailKind: "tool_started",
      detail: "Archiving channel…",
      toolName: "archive_channel",
      toolInput: "#general",
    },
    {
      command: "coforge channel lifecycle unarchive --target #general",
      detailKind: "tool_started",
      detail: "Unarchiving channel…",
      toolName: "unarchive_channel",
      toolInput: "#general",
    },
    {
      command: "coforge channel add-member --target #general --user @bob",
      detailKind: "tool_started",
      detail: "Adding channel member…",
      toolName: "add_channel_member",
      toolInput: "#general",
    },
    {
      command: "coforge channel remove-member --target #general --agent @scout",
      detailKind: "tool_started",
      detail: "Removing channel member…",
      toolName: "remove_channel_member",
      toolInput: "#general",
    },
    {
      command: "coforge channel join --target #general",
      detailKind: "tool_started",
      detail: "Joining channel…",
      toolName: "join_channel",
      toolInput: "#general",
    },
    {
      command: "coforge channel leave --target #general",
      detailKind: "tool_started",
      detail: "Leaving channel…",
      toolName: "leave_channel",
      toolInput: "#general",
    },
    {
      command: "coforge task list --target #general --status all",
      detailKind: "tool_started",
      detail: "Listing tasks…",
      toolName: "list_tasks",
      toolInput: "#general",
    },
    {
      command: "coforge task create --target #general --title 'Ship the thing'",
      detailKind: "tool_started",
      detail: "Creating tasks…",
      toolName: "create_tasks",
      toolInput: "#general",
    },
    {
      command: "coforge task claim --target #general --number 7 --number 8",
      detailKind: "tool_started",
      detail: "Claiming tasks…",
      toolName: "claim_tasks",
      toolInput: "#general #t7,#t8",
    },
    {
      command: "coforge task claim --target #general --message-id deadbeef",
      detailKind: "tool_started",
      detail: "Claiming tasks…",
      toolName: "claim_tasks",
      toolInput: "#general",
    },
    {
      command: "coforge task unclaim --target #general --number 7",
      detailKind: "tool_started",
      detail: "Unclaiming task…",
      toolName: "unclaim_task",
      toolInput: "#general #t7",
    },
    {
      command: "coforge task update --target #general --number 7 --status done",
      detailKind: "tool_started",
      detail: "Updating task status…",
      toolName: "update_task_status",
      toolInput: "#general #t7",
    },
    {
      command: "coforge task update --target #general --status done",
      detailKind: "tool_started",
      detail: "Updating task status…",
      toolName: "update_task_status",
    },
    {
      command: "coforge attachment upload --path ./shot.png --target #general",
      detailKind: "tool_started",
      detail: "Uploading file…",
      toolName: "upload_file",
      toolInput: "./shot.png",
    },
    {
      command: "coforge attachment view --id deadbeef --output /tmp/out.png",
      detailKind: "tool_started",
      detail: "Viewing file…",
      toolName: "view_file",
    },
    {
      command:
        "coforge reminder schedule --title 'Follow up with finance' --target @bob --message-id deadbeef --delay-seconds 60",
      detailKind: "tool_started",
      detail: "Scheduling reminder…",
      toolName: "schedule_reminder",
      toolInput: "Follow up with finance",
    },
    {
      command: `coforge reminder schedule --title '${"r".repeat(41)}' --delay-seconds 60`,
      detailKind: "tool_started",
      detail: "Scheduling reminder…",
      toolName: "schedule_reminder",
      toolInput: `${"r".repeat(40)}…`,
    },
    {
      command: "coforge reminder list --all",
      detailKind: "tool_started",
      detail: "Listing reminders…",
      toolName: "list_reminders",
    },
    {
      command: "coforge reminder cancel --id deadbeef-dead-beef-dead-beefdeadbeef",
      detailKind: "tool_started",
      detail: "Canceling reminder…",
      toolName: "cancel_reminder",
      toolInput: "#deadbeef",
    },
    {
      command: "/usr/local/bin/coforge message check",
      detailKind: "checking_messages",
      detail: "Checking messages…",
      toolName: "check_messages",
    },
  ];
  for (const { command, detailKind, detail, toolName, toolInput } of cases) {
    const result = toolActivity("bash", { command });
    expect(result).toMatchObject({
      detailKind,
      detail,
      entries: [{ kind: "tool_start", toolName, ...(toolInput ? { toolInput } : {}) }],
    });
    if (toolInput === undefined) expect(result.entries[0]).not.toHaveProperty("toolInput");
  }
});

test("CoForge subcommands outside the reference client's set are ordinary commands", () => {
  for (const command of [
    "coforge message resolve deadbeef",
    "coforge message react --message-id deadbeef --emoji :+1:",
    "coforge channel mute --target #general",
    "coforge channel unmute --target #general",
    "coforge channel info #general",
    "coforge channel create --name launch",
    "coforge thread unfollow --target #general:deadbeef",
    "coforge task convert --target #general --message-id deadbeef",
    "coforge task assign --target #general --number 7 --assignee @bob",
    "coforge task unassign --target #general --number 7",
    "coforge task amend --target #general --number 7 --title New",
    "coforge task history --target #general --number 7",
    "coforge task delete --target #general --number 7",
    "coforge task receipt --target #general --number 7",
    "coforge reminder update --id deadbeef-dead-beef-dead-beefdeadbeef --title New",
    "coforge reminder snooze --id deadbeef-dead-beef-dead-beefdeadbeef --delay-seconds 60",
    "coforge reminder log --id deadbeef-dead-beef-dead-beefdeadbeef",
    "coforge reminder ack --id deadbeef-dead-beef-dead-beefdeadbeef --revision 3",
    "coforge reminder dismiss --id deadbeef-dead-beef-dead-beefdeadbeef --revision 3",
    "coforge weekly-report context --subject-type report --subject-id deadbeef",
    "coforge manual get index",
    "coforge manual search github",
    "coforge user info @alice",
    "coforge profile show @scout",
    "coforge profile update --display-name Scout",
    "coforge whoami --json",
    "coforge version --json",
    // The Computer's local held view; only the server drain (`message check`) is semantic.
    "coforge inbox check",
    "coforge workspace info --agents",
    "coforge something-new --flag value",
    "coforge",
  ])
    expect(toolActivity("bash", { command })).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: command }],
    });
});

test("a CoForge invocation is recognized in any chained segment, behind env assignments or a shell -c wrapper", () => {
  const cases: [string, string, string | undefined][] = [
    ["COFORGE_X=1 coforge channel join --target #general", "join_channel", "#general"],
    ["bash -c 'coforge channel join --target #general'", "join_channel", "#general"],
    ['zsh -lc "coforge task list --target #general"', "list_tasks", "#general"],
    ["sh -c 'A=1 coforge message check'", "check_messages", undefined],
    ["cd /work && coforge channel leave --target #general", "leave_channel", "#general"],
    ["true; B=2 coforge message read --target @alice", "read_history", "@alice"],
    ["coforge channel join --target=#general", "join_channel", "#general"],
    ["coforge message send --target @a --target @b", "send_message", "@b"],
    ["coforge message check | grep unread", "check_messages", undefined],
    ["coforge task list --target #general && echo done", "list_tasks", "#general"],
    ["coforge message check; echo done", "check_messages", undefined],
  ];
  for (const [command, toolName, toolInput] of cases) {
    const result = toolActivity("bash", { command });
    expect(result.entries).toEqual([
      { kind: "tool_start", toolName, ...(toolInput ? { toolInput } : {}) },
    ]);
  }
});

test("the CoForge message send heredoc form never leaks the message body", () => {
  const command = [
    "coforge message send --target @bob <<'COFORGE_MESSAGE'",
    "Here is the deploy password: hunter2 and the API key: sk-liveTESTsecret",
    "COFORGE_MESSAGE",
  ].join("\n");
  const result = toolActivity("bash", { command });
  expect(result).toMatchObject({
    detailKind: "tool_started",
    detail: "Sending message…",
    entries: [{ kind: "tool_start", toolName: "send_message", toolInput: "@bob" }],
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("sk-liveTESTsecret");
  expect(serialized).not.toContain("Here is the deploy password");
});

test("CoForge CLI tokenising respects quotes and backslashes", () => {
  expect(
    toolActivity("bash", { command: "coforge channel join --target '#has spaces'" }),
  ).toMatchObject({ entries: [{ toolInput: "#has spaces" }] });
  expect(
    toolActivity("bash", {
      command: 'coforge message search --query "say \\"hi\\" now" --target #general',
    }),
  ).toMatchObject({ entries: [{ toolInput: 'say "hi" now' }] });
  expect(
    toolActivity("bash", { command: "coforge channel join --target \\#escaped-space" }),
  ).toMatchObject({ entries: [{ toolInput: "#escaped-space" }] });
});

test("a non-coforge shell command is an ordinary command", () => {
  expect(toolActivity("bash", { command: "bun test packages/daemon" })).toMatchObject({
    detailKind: "running_command",
    detail: "Running command…",
    entries: [{ kind: "tool_start", toolName: "bash", toolInput: "bun test packages/daemon" }],
  });
});
test("a provider's own message-check tool reports checking_messages, as the CLI form does", () => {
  for (const name of ["check_messages", "receive_message"])
    expect(toolActivity(name, {})).toMatchObject({
      detailKind: "checking_messages",
      detail: "Checking messages…",
    });
});
