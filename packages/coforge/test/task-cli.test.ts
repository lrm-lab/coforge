import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { CliError } from "#src/cli-error";
import {
  type TaskClaimResult,
  type TaskCommand,
  validateTaskRequest,
} from "@lrm/coforge-sdk/internal";
import { NO_RELATIONS } from "./no-relations";
import { taskStamps } from "./task-stamps";

/** A transport whose every call but `task` answers with nothing: the task tests supply `task`. */
const idleTransport = {
  check: async () => ({ messages: [] }),
  read: async () => ({}),
  send: async () => ({}),
  view: async () => ({ bytes: new Uint8Array() }),
};

test("Task claim prints each selector's outcome, and fails typed with the rows when none was claimed", async () => {
  const transport = (claims: TaskClaimResult[]) => ({
    ...idleTransport,
    task: async () => ({ tasks: [], claims }),
  });
  expect(
    await run(
      ["task", "claim", "--target", "#general", "--number", "4", "--number", "5"],
      transport([
        { number: 4, messageId: "4abcdef0-0000-0000-0000-000000000000", success: true },
        { number: 5, success: false, reason: "task is done" },
      ]),
    ),
  ).toStartWith(
    "Claim results (1 claimed, 1 failed):\n#4 (msg:4abcdef0-0000): claimed\n#5: FAILED — task is done.",
  );
  const refused = await run(
    ["task", "claim", "--target", "#general", "--number", "5"],
    transport([
      {
        number: 5,
        success: false,
        reason: "already claimed",
        conflict: {
          kind: "claim_conflict",
          conflictScope: "implementation_execution",
          blockedActions: ["start_conflicting_execution"],
          unblockedActionExamples: ["reply in the task's thread"],
          currentAssignee: { type: "user", name: "bob" },
          taskStatus: "in_progress",
          claimedAt: null,
          observedAt: "2026-09-23T06:00:00.000Z",
        },
      },
    ]),
  ).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(CliError);
  expect(refused).toMatchObject({
    code: "CLAIM_CONFLICT",
    message: expect.stringContaining("Claim refused — #5 held by @bob."),
    contextText: expect.stringContaining("#5: Claim failed — @bob currently holds"),
  });
});

test("A refused Task delete names who may delete it", async () => {
  const refused = await run(["task", "delete", "--target", "#general", "--number", "3"], {
    ...idleTransport,
    task: async () => {
      throw new CliError({
        code: "DELETE_FAILED",
        message: "this agent is not allowed to do that",
        retryable: false,
        correlationId: "correlation-1",
        proxy: { failureClass: "upstream_http_response", upstreamStatus: 403 },
      });
    },
  }).catch((error: unknown) => error);
  expect(refused).toMatchObject({
    code: "DELETE_FAILED",
    message: "this agent is not allowed to do that",
    correlationId: "correlation-1",
    suggestedNextAction:
      "Only the task's creator or a Workspace owner or admin can delete a task; ask one of them, or close it instead.",
  });
});

test("Task create sends every title and prints each new Task with its thread", async () => {
  const calls: TaskCommand[] = [];
  const output = await run(
    ["task", "create", "--target", "@ada", "--title", "Draft", "--title", "Review"],
    {
      ...idleTransport,
      task: async (command) => {
        validateTaskRequest(command);
        calls.push(command);
        return {
          tasks: (command.titles ?? []).map((title, index) => ({
            messageId: `${index + 1}abcdef0-0000-0000-0000-000000000000`,
            conversationId: "conversation",
            number: index + 1,
            title,
            status: "todo" as const,
            revision: 0,
            ...NO_RELATIONS,
            ...taskStamps,
            owner: null,
            claimedAt: null,
          })),
        };
      },
    },
  );
  expect(calls).toEqual([
    expect.objectContaining({ operation: "create", titles: ["Draft", "Review"] }),
  ]);
  expect(output).toBe(
    [
      "Created 2 task(s) in @ada:",
      '#1 [todo] assignee=unassigned claimedAt=null msg=1abcdef0-0000 "Draft"',
      '#2 [todo] assignee=unassigned claimedAt=null msg=2abcdef0-0000 "Review"',
      "",
      "To follow up in each task's thread:",
      '#1 → coforge message send --target "@ada:1abcdef0-0000"',
      '#2 → coforge message send --target "@ada:2abcdef0-0000"',
    ].join("\n"),
  );
});

test("Task receipt forwards all seven fields through the backend contract", async () => {
  const receipt = {
    object: "bucket preview-719",
    purpose: "Review build artifacts",
    teardownOwner: "@ada",
    securityPrivacy: "Private; no credentials stored",
    expiry: "2030-03-04T05:06:00.000Z",
    runbook: "docs/cleanup.md",
    tracking: "#general:12345678",
  };
  const flags = [
    "--object",
    "--purpose",
    "--teardown-owner",
    "--security-privacy",
    "--expiry",
    "--runbook",
    "--tracking",
  ];
  const values = [
    receipt.object,
    receipt.purpose,
    receipt.teardownOwner,
    receipt.securityPrivacy,
    "2030-03-04T13:06:00+08:00",
    receipt.runbook,
    receipt.tracking,
  ];
  const base = ["task", "receipt", "--target", "#general", "--number", "7"];
  const calls: unknown[] = [];
  const output = await run(
    [...base, ...flags.flatMap((flag, index) => [flag, ` ${values[index]} `])],
    {
      ...idleTransport,
      task: async (command) => {
        validateTaskRequest(command);
        calls.push(command);
        return {
          tasks: [
            {
              messageId: "7abcdef0-0000-0000-0000-000000000000",
              conversationId: "conversation",
              number: 7,
              title: "Preview bucket",
              status: "in_progress",
              revision: 4,
              ...NO_RELATIONS,
              ...taskStamps,
              owner: null,
              requiresResourceReceipt: true,
              resourceReceiptRecordedAt: "2026-09-23T07:00:00.000Z",
            },
          ],
          resourceFollowup: {
            id: "0f1e2d3c-0000-0000-0000-000000000000",
            ownerAgentId: "agent",
            owner: "@ada",
            fireAt: receipt.expiry,
            messageId: "7abcdef0-0000-0000-0000-000000000000",
            targetChannelId: "5a5a5a5a-0000-0000-0000-000000000000",
          },
        };
      },
    },
  );
  expect(calls).toEqual([expect.objectContaining({ operation: "receipt", number: 7, receipt })]);
  expect(output).toBe(
    [
      "Resource receipt recorded for task #7 in #general.",
      "Expiry follow-up 0f1e2d3c-0000 owned by @ada fires 2030-03-04T05:06:00.000Z.",
      "Follow-up anchor: msg=7abcdef0-0000 targetChannelId=5a5a5a5a-0000-0000-0000-000000000000.",
    ].join("\n"),
  );
  for (const omitted of flags)
    expect(() =>
      parseArgs([
        ...base,
        ...flags.flatMap((flag, index) => (flag === omitted ? [] : [flag, values[index]!])),
      ]),
    ).toThrow();
});

test("Task amendment rejects conflicting description options before dispatch", async () => {
  for (const options of [
    ["--description", "Keep deployment instructions", "--clear-description"],
    ["--clear-description", "--description", "Keep deployment instructions"],
  ]) {
    const calls: unknown[] = [];
    await expect(
      run(["task", "amend", "--target", "#general", "--number", "7", ...options], {
        ...idleTransport,
        task: async (command) => {
          calls.push(command);
          return { tasks: [] };
        },
      }),
    ).rejects.toThrow("Use either --description or --clear-description, not both");
    expect(calls).toEqual([]);
  }
});

test("Task update reads one revision then submits once and confirms the new status", async () => {
  const calls: any[] = [];
  const output = await run(
    ["task", "update", "--target", "#general", "--number", "2", "--status", "in_review"],
    {
      ...idleTransport,
      task: async (command) => {
        calls.push(command);
        return {
          tasks: [
            {
              messageId: "message-2",
              conversationId: "conversation",
              number: 2,
              title: "Verify",
              status: command.operation === "update" ? "in_review" : "in_progress",
              revision: 5,
              ...NO_RELATIONS,
              ...taskStamps,
              owner: {
                memberId: "member",
                kind: "agent",
                id: "agent",
                name: "builder",
                handle: "builder",
              },
            },
          ],
        };
      },
    },
  );
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ operation: "update", expectedRevision: 5 });
  expect(output).toBe("#2 moved to in_review.");
});

test("Task list prints a conversation's board and an Agent's own list", async () => {
  const calls: any[] = [];
  const transport = {
    ...idleTransport,
    task: async (command: any) => {
      calls.push(command);
      return {
        tasks: [
          {
            messageId: "46abcdef-0000-0000-0000-000000000000",
            conversationId: "conversation",
            number: 46,
            title: "Half-done work",
            status: "in_progress" as const,
            revision: 3,
            ...NO_RELATIONS,
            ...taskStamps,
            channelRef: command.mine ? "#general" : undefined,
            owner: {
              memberId: "member",
              kind: "agent" as const,
              id: "agent",
              name: "Kiro",
              handle: "kiro",
              deleted: true,
            },
          },
        ],
        ...(command.mine && {
          coverage: {
            status: "incomplete" as const,
            visibleConversationKinds: ["channel" as const, "dm" as const],
            includesArchived: true,
            inaccessibleScope: "not_asserted" as const,
            reason: "Reads the channels and DMs this Agent is a member of now.",
          },
          pagination: { mode: "complete" as const, truncated: false as const },
        }),
      };
    },
  };
  expect(await run(["task", "list", "--target", "#general"], transport)).toBe(
    "## Task Board for #general (1 tasks)\n\n" +
      "#46 [in_progress] Half-done work → @kiro [deleted] (by @ada) msg=46abcdef-0000 rev=3 created=2026-09-23 05:00:00Z updated=2026-09-23 06:00:00Z",
  );
  expect(await run(["task", "list", "--mine", "--status", "all"], transport)).toBe(
    [
      "## My assigned tasks in this Workspace (status=all)",
      "",
      "Coverage: incomplete · visible kinds=channel|dm · archived=included · inaccessible scope=not_asserted",
      "Output: showing 1 of 1 visible matches · mode=complete · truncated=false",
      "",
      "### in_progress (1)",
      "- #general task #46 [in_progress] by=@ada msg=46abcdef-0000 created=2026-09-23 05:00:00Z updated=2026-09-23 06:00:00Z Half-done work",
    ].join("\n"),
  );
  expect(calls[1]).toMatchObject({ operation: "list", mine: true, status: "all" });
  expect(calls[1].target).toBeUndefined();
});

test("Task unclaim reads one revision unless explicitly supplied and submits once", async () => {
  for (const args of [
    ["task", "unclaim", "--target", "#general", "--number", "2"],
    ["task", "unclaim", "--target", "#general", "--number", "2", "--expected-revision", "4"],
  ]) {
    const calls: any[] = [];
    await run(args, {
      ...idleTransport,
      task: async (command) => {
        calls.push(command);
        return {
          tasks: [
            {
              messageId: "message-2",
              conversationId: "conversation",
              number: 2,
              title: "Verify",
              status: "in_progress",
              revision: 4,
              ...NO_RELATIONS,
              ...taskStamps,
              owner: {
                memberId: "member",
                kind: "agent",
                id: "agent",
                name: "builder",
                handle: "builder",
              },
            },
          ],
        };
      },
    });
    expect(calls.at(-1)).toMatchObject({ operation: "unclaim", expectedRevision: 4 });
    expect(calls).toHaveLength(args.includes("--expected-revision") ? 1 : 2);
  }
});

test("Task unassign submits its own protocol operation with no assignee", async () => {
  const calls: any[] = [];
  const output = await run(["task", "unassign", "--target", "#general", "--number", "2"], {
    ...idleTransport,
    task: async (command) => {
      calls.push(command);
      return {
        tasks: [
          {
            messageId: "message-2",
            conversationId: "conversation",
            number: 2,
            title: "Verify",
            status: "in_progress",
            revision: 4,
            ...NO_RELATIONS,
            ...taskStamps,
            owner: null,
          },
        ],
      };
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ operation: "unassign", number: 2 });
  expect(calls[0]).not.toHaveProperty("assignee");
  expect(output).toBe("#2 unassigned — now open.");
});

test("Task amend may change only a relation, through the daemon's own validation", async () => {
  const calls: TaskCommand[] = [];
  const transport = {
    ...idleTransport,
    task: async (command: TaskCommand) => {
      validateTaskRequest(command);
      calls.push(command);
      return {
        tasks: [
          {
            messageId: "message-7",
            conversationId: "conversation",
            number: 7,
            title: "Fix it",
            status: "todo" as const,
            revision: 2,
            ...NO_RELATIONS,
            ...taskStamps,
            owner: null,
          },
        ],
      };
    },
  };
  await run(
    ["task", "amend", "--target", "#general", "--number", "7", "--blocked-by", "#qa-other:#2"],
    transport,
  );
  await run(
    ["task", "amend", "--target", "#general", "--number", "7", "--parent", "#general:#5"],
    transport,
  );
  expect(calls[0]).toMatchObject({
    operation: "amend",
    number: 7,
    blockedBy: [{ number: 2, channel: "qa-other" }],
  });
  expect(calls[0]).not.toHaveProperty("title");
  expect(calls[1]).toMatchObject({
    operation: "amend",
    number: 7,
    parent: { number: 5, channel: "general" },
  });
});
