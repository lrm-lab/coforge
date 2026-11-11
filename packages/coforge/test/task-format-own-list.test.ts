import { expect, test } from "bun:test";
import { formatMyTaskList } from "#src/task-format";
import { coverage, person, task } from "./task-format-fixtures";

test("An Agent's own list groups its Tasks by status and states the coverage it was given", () => {
  const text = formatMyTaskList(
    {
      tasks: [
        task(7, { status: "in_progress", channelRef: "#general", title: "Ship\n  the   fix" }),
        task(2, {
          channelRef: "@ada",
          creator: person("kiro", { kind: "agent", deleted: true }),
          requiresResourceReceipt: true,
        }),
        task(9, {
          status: "in_progress",
          channelRef: "#ops",
          creator: person("bob", { left: true }),
        }),
      ],
      coverage,
      pagination: { mode: "complete", truncated: false },
    },
    undefined,
  );
  expect(text).toBe(
    [
      "## My assigned tasks in this Workspace (unfinished)",
      "",
      "Coverage: incomplete · visible kinds=channel|dm · archived=included · inaccessible scope=not_asserted",
      "Output: showing 3 of 3 visible matches · mode=complete · truncated=false",
      "",
      "### todo (1)",
      "- @ada task #2 [todo] prio=none by=@kiro creator=deleted msg=2abcdef0-1111 resource-receipt=pending created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Task 2",
      "### in_progress (2)",
      "- #general task #7 [in_progress] prio=none by=@ada msg=7abcdef0-1111 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Ship the fix",
      "- #ops task #9 [in_progress] prio=none by=@bob creator=left msg=9abcdef0-1111 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Task 9",
    ].join("\n"),
  );
});

test("An Agent's own list leads with its numbered queue when the server sends one (task #716)", () => {
  const first = task(2, { channelRef: "#general", title: "First" });
  const second = task(7, {
    status: "in_progress",
    channelRef: "@ada",
    title: "Second",
  });
  const waiting = task(9, { status: "in_review", channelRef: "#ops", title: "Waiting" });
  const text = formatMyTaskList(
    {
      tasks: [first, second, waiting],
      queue: [
        { position: 1, taskId: first.id },
        { position: 2, taskId: second.id },
      ],
      coverage,
      pagination: { mode: "complete", truncated: false },
    },
    undefined,
  );
  expect(text).toBe(
    [
      "## My assigned tasks in this Workspace (unfinished)",
      "",
      "Coverage: incomplete · visible kinds=channel|dm · archived=included · inaccessible scope=not_asserted",
      "Output: showing 3 of 3 visible matches · mode=complete · truncated=false",
      "",
      "### Your queue",
      "#1 #general task #2 [todo] prio=none First",
      "#2 @ada task #7 [in_progress] prio=none Second",
      "",
      "### todo (1)",
      "- #general task #2 [todo] prio=none queue=1 by=@ada msg=2abcdef0-1111 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z First",
      "### in_progress (1)",
      "- @ada task #7 [in_progress] prio=none queue=2 by=@ada msg=7abcdef0-1111 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Second",
      "### in_review (1)",
      "- #ops task #9 [in_review] prio=none by=@ada msg=9abcdef0-1111 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Waiting",
    ].join("\n"),
  );

  // A filtered list keeps each row's true queue place and says how much of the queue it shows.
  const filtered = formatMyTaskList(
    {
      tasks: [second],
      queue: [
        { position: 1, taskId: first.id },
        { position: 2, taskId: second.id },
        { position: 3, taskId: "filtered-out" },
      ],
      coverage,
      pagination: { mode: "complete", truncated: false },
    },
    "in_progress",
  );
  expect(filtered).toBe(
    [
      "## My assigned tasks in this Workspace (status=in_progress)",
      "",
      "Coverage: incomplete · visible kinds=channel|dm · archived=included · inaccessible scope=not_asserted",
      "Output: showing 1 of 1 visible matches · mode=complete · truncated=false",
      "",
      "### Your queue (1 of 3 shown)",
      "#2 @ada task #7 [in_progress] prio=none Second",
      "",
      "### in_progress (1)",
      "- @ada task #7 [in_progress] prio=none queue=2 by=@ada msg=7abcdef0-1111 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Second",
    ].join("\n"),
  );

  // A filter that hides every queued row still says the queue is there — and an empty filtered
  // list does not hide it either.
  const noneShown = formatMyTaskList(
    {
      tasks: [waiting],
      queue: [
        { position: 1, taskId: first.id },
        { position: 2, taskId: second.id },
      ],
      coverage,
      pagination: { mode: "complete", truncated: false },
    },
    "in_review",
  );
  expect(noneShown).toContain("### Your queue (0 of 2 shown)\n\n### in_review (1)");
  const empty = formatMyTaskList(
    {
      tasks: [],
      queue: [
        { position: 1, taskId: first.id },
        { position: 2, taskId: second.id },
      ],
      coverage,
      pagination: { mode: "complete", truncated: false },
    },
    "done",
  );
  expect(empty).toContain(
    "No tasks matched in the covered visible scope.\n\n### Your queue (0 of 2 shown)",
  );
});

test("An empty own list still states its coverage, and a missing field reads unknown", () => {
  expect(
    formatMyTaskList(
      {
        tasks: [],
        coverage: { ...coverage, includesArchived: false },
        pagination: { mode: "complete", truncated: false },
      },
      "done",
    ),
  ).toBe(
    [
      "## My assigned tasks in this Workspace (status=done)",
      "",
      "Coverage: incomplete · visible kinds=channel|dm · archived=not included · inaccessible scope=not_asserted",
      "Output: showing 0 of 0 visible matches · mode=complete · truncated=false",
      "",
      "No tasks matched in the covered visible scope.",
    ].join("\n"),
  );
  expect(formatMyTaskList({ tasks: [] }, "all").split("\n").slice(0, 4)).toEqual([
    "## My assigned tasks in this Workspace (status=all)",
    "",
    "Coverage: unknown · visible kinds=unknown · archived=unknown · inaccessible scope=unknown",
    "Output: showing 0 of 0 visible matches · mode=unknown · truncated=unknown",
  ]);
});

test("A status the CLI does not know gets its own section instead of dropping the row (task #61)", () => {
  const parked = task(11, {
    status: "backlog" as TaskView["status"],
    channelRef: "#general",
    title: "Someday",
  });
  const text = formatMyTaskList(
    {
      tasks: [parked, task(2, { channelRef: "@ada" })],
      coverage,
      pagination: { mode: "complete", truncated: false },
    },
    undefined,
  );
  expect(text).toContain("### todo (1)");
  expect(text).toContain("### other (1)");
  expect(text).toContain("task #11 [backlog] prio=none by=@ada msg=11abcdef0-111 created=");
});
