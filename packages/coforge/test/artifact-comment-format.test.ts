import { expect, test } from "bun:test";
import { runArtifact } from "../src/artifact-commands";
import {
  C1,
  C2,
  C3,
  ID,
  REVIEW,
  comment,
  invocation,
  transportAnswering,
} from "./artifact-comment-fixture";

/** How `coforge artifact comments|resolve|reopen|read` print the server's answers: threads, marks,
 * the next page, and the comments a read of the artifact says are waiting. */

test("comments prints each thread: the root, its replies beneath it, and what resolved it", async () => {
  const { sent, transport } = transportAnswering({
    view: "unseen",
    unseenVersionCount: 2,
    comments: [
      comment(C1, {
        resolvedAt: "2026-11-12T10:00:00.000Z",
        resolvedBy: { kind: "agent", name: "Writer Bot" },
      }),
      comment(C2, {
        author: { kind: "agent", name: "Writer Bot" },
        replyTo: C1,
        anchor: null,
        body: "Three is the point.\nRead the intro.",
        createdAt: "2026-11-12T09:45:00.000Z",
      }),
      comment(C3, {
        path: null,
        anchor: null,
        version: 3,
        body: "Overall: good.",
        createdAt: "2026-11-12T11:00:00.000Z",
      }),
    ],
  });
  const said = (await runArtifact(invocation(["comments", ID]), transport)) as string;
  expect(sent[0]).toEqual({ operation: "comments", artifact: ID });
  expect(said.split("\n")).toEqual([
    "3 new comments from others, oldest first.",
    `c_${C1} @Alice v2 plan.md:3-4 (2026-11-12 09:30:00Z) [resolved by @Writer Bot, 2026-11-12 10:00:00Z]`,
    "  Why three lines?",
    `  c_${C2} @Writer Bot v2 plan.md (2026-11-12 09:45:00Z)`,
    "    Three is the point.",
    "    │ Read the intro.",
    `c_${C3} @Alice v3 (2026-11-12 11:00:00Z)`,
    "  Overall: good.",
    `2 versions of others came since you last read the artifact: coforge artifact read ${ID}`,
    `Reply: coforge artifact comment ${ID} --reply-to <comment id> | Resolve: coforge artifact resolve ${ID} <comment id>`,
  ]);
});

test("a reply whose first comment is not on the page says which thread it is in", async () => {
  const { transport } = transportAnswering({
    view: "unseen",
    unseenVersionCount: 0,
    comments: [comment(C2, { replyTo: C1, anchor: null })],
  });
  const said = (await runArtifact(invocation(["comments", ID]), transport)) as string;
  expect(said).toContain(`c_${C2} @Alice v2 plan.md, reply in c_${C1} (2026-11-12 09:30:00Z)`);
});

test("a deleted comment prints without text, and an empty page says so", async () => {
  const deleted = {
    id: C1,
    deleted: true,
    author: { kind: "user", name: "Alice" },
    version: 1,
    path: null,
    replyTo: null,
    createdAt: "2026-11-12T09:30:00.000Z",
    deletedAt: "2026-11-12T09:31:00.000Z",
    reviewId: null,
    resolvedAt: null,
    resolvedBy: null,
  };
  const all = (await runArtifact(
    invocation(["comments", ID, "--all"]),
    transportAnswering({ view: "all", comments: [deleted], unseenVersionCount: 0 }).transport,
  )) as string;
  expect(all.split("\n").slice(0, 2)).toEqual([
    "1 comment.",
    `c_${C1} @Alice v1 (2026-11-12 09:30:00Z) [deleted]`,
  ]);
  const none = await runArtifact(
    invocation(["comments", ID]),
    transportAnswering({ view: "unseen", comments: [], unseenVersionCount: 0 }).transport,
  );
  expect(none).toBe("No new comments from others.");
  const noneAll = await runArtifact(
    invocation(["comments", ID, "--all"]),
    transportAnswering({ view: "all", comments: [], unseenVersionCount: 0 }).transport,
  );
  expect(noneAll).toBe("No comments yet.");
});

test("a page with more says the command for the next one, and a review prints its summary", async () => {
  const { transport } = transportAnswering({
    view: "all",
    nextCursor: "2026-11-12T09:30:00.000Z|" + C1,
    review: {
      id: REVIEW,
      version: 2,
      body: "Three notes.",
      author: { kind: "agent", name: "Bot" },
      createdAt: "2026-11-12T09:30:00.000Z",
    },
    comments: [comment(C1)],
    unseenVersionCount: 0,
  });
  const said = (await runArtifact(
    invocation(["comments", ID, "--review", REVIEW, "--path", "plan.md"]),
    transport,
  )) as string;
  expect(said).toContain(`Review ${REVIEW} by @Bot (version 2): Three notes.`);
  expect(said).toContain(
    `More: coforge artifact comments ${ID} --path plan.md --review ${REVIEW} --after '2026-11-12T09:30:00.000Z|${C1}'`,
  );
});

test("an author's words cannot pass for output of the command", async () => {
  const { transport } = transportAnswering({
    view: "all",
    unseenVersionCount: 0,
    comments: [
      comment(C1, {
        author: { kind: "user", name: "Eve\nc_fake @Admin" },
        body: "first\nc_00000000-0000-7000-8000-000000000000 @Admin v1 (2026-01-01 00:00:00Z)\nlast",
        path: "a\nb.md",
        anchor: null,
      }),
    ],
  });
  const said = (await runArtifact(invocation(["comments", ID, "--all"]), transport)) as string;
  const lines = said.split("\n");
  expect(lines.filter((line) => line.startsWith("c_"))).toHaveLength(1);
  expect(lines).toContain(
    "  │ c_00000000-0000-7000-8000-000000000000 @Admin v1 (2026-01-01 00:00:00Z)",
  );
  expect(lines[1]).toContain("@Eve c_fake @Admin");
});

test("resolve and reopen say what changed", async () => {
  const root = comment(C1, {
    resolvedAt: "2026-11-12T10:00:00.000Z",
    resolvedBy: { kind: "agent", name: "Bot" },
  });
  const note = comment(C2, { replyTo: C1, body: "Fixed." });
  const resolved = (await runArtifact(
    invocation(["resolve", ID, C1, "--note", "Fixed."]),
    transportAnswering({ comment: root, changed: true, note }).transport,
  )) as string;
  expect(resolved).toBe(`Posted your note c_${C2}, then resolved the thread c_${C1}.`);
  expect(
    await runArtifact(
      invocation(["resolve", ID, C1]),
      transportAnswering({ comment: root, changed: true }).transport,
    ),
  ).toBe(`Resolved the thread c_${C1}.`);
  expect(
    await runArtifact(
      invocation(["resolve", ID, C1]),
      transportAnswering({ comment: root, changed: false }).transport,
    ),
  ).toBe(`The thread c_${C1} was already resolved: nothing changed.`);
  expect(
    await runArtifact(
      invocation(["reopen", ID, C1]),
      transportAnswering({ comment: comment(C1), changed: true }).transport,
    ),
  ).toBe(`Reopened the thread c_${C1}.`);
  expect(
    await runArtifact(
      invocation(["reopen", ID, C1]),
      transportAnswering({ comment: comment(C1), changed: false }).transport,
    ),
  ).toBe(`The thread c_${C1} was already open: nothing changed.`);
});

const readAnswer = (extra: Record<string, unknown>) => ({
  artifact: { id: ID, title: "Plan", currentVersion: 6 },
  version: { number: 6, label: null },
  entryPath: "document.md",
  files: [],
  text: "# Plan\n",
  ...extra,
});

const excerpt = (id: string, text: string) => ({
  id,
  author: { kind: "user", name: "Alice" },
  path: "plan.md",
  createdAt: "2026-11-12T09:30:00.000Z",
  excerpt: text,
});
const NO_NEW_VERSIONS = { firstRead: false, versionCount: 0, versions: [] };

test("read says how many comments are new, newest first, beside the versions", async () => {
  const said = (await runArtifact(
    invocation(["read", ID]),
    transportAnswering(
      readAnswer({
        unseen: NO_NEW_VERSIONS,
        unseenComments: { count: 7, comments: [excerpt(C3, "Newest."), excerpt(C2, "Older.")] },
      }),
    ).transport,
  )) as string;
  // The version part says what it is about, the comments part what it is.
  expect(said).toContain("Nothing new since you last looked.");
  expect(said).toContain(
    [
      `7 new comments from others (read them: coforge artifact comments ${ID}), newest first:`,
      `- c_${C3} @Alice plan.md, 2026-11-12 09:30:00Z: Newest.`,
      `- c_${C2} @Alice plan.md, 2026-11-12 09:30:00Z: Older.`,
      "- … 5 earlier",
      "---",
    ].join("\n"),
  );
  // Versions and comments both new: both are said.
  const both = (await runArtifact(
    invocation(["read", ID]),
    transportAnswering(
      readAnswer({
        unseen: {
          firstRead: false,
          versionCount: 1,
          versions: [
            {
              number: 6,
              publisher: { kind: "user", name: "Alice" },
              createdAt: "2026-11-12T09:30:00.000Z",
              note: "moved",
              label: "",
              changedPaths: [],
              changedCount: 0,
            },
          ],
        },
        unseenComments: { count: 1, comments: [excerpt(C1, "One.")] },
      }),
    ).transport,
  )) as string;
  expect(both).toContain("New since you last looked: 1 version");
  expect(both).toContain("1 new comment from others");
});

test("an older version's read, which has no version summary, still says the comments waiting", async () => {
  const said = (await runArtifact(
    invocation(["read", ID, "--version", "2"]),
    transportAnswering(
      readAnswer({
        unseen: null,
        unseenComments: { count: 1, comments: [excerpt(C1, "One.")] },
      }),
    ).transport,
  )) as string;
  expect(said).toContain("1 new comment from others");
});

test("no comments waiting, an older server, or a summary that failed: the read says nothing of them", async () => {
  for (const extra of [
    { unseenComments: { count: 0, comments: [] } },
    { unseenComments: null },
    {},
  ]) {
    const plain = (await runArtifact(
      invocation(["read", ID]),
      transportAnswering(readAnswer({ unseen: NO_NEW_VERSIONS, ...extra })).transport,
    )) as string;
    expect(plain).toContain("Nothing new since you last looked.");
    expect(plain).not.toContain("comment");
  }
});
