import { expect, test } from "bun:test";
import { parseArgs } from "../index";
import { isTaskRef, refuseTaskRef } from "../src/task-target-refusal";

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

test("only a board plus :#N is a task ref", () => {
  for (const ref of ["#general:#7", "dm:@ada:#7"]) expect(isTaskRef(ref)).toBe(true);
  for (const target of [
    "#general",
    "@ada",
    "@ada:#7",
    "dm:@ada",
    "#general:abcd1234",
    "#general:#x",
    "#general:#07",
  ])
    expect(isTaskRef(target)).toBe(false);
});

test("message send refuses a task ref and shows the task reply command", () => {
  const error = refusal(() => parseArgs(["message", "send", "--target", "#general:#7"]));
  expect(error.code).toBe("TASK_TARGET_USE_TASK_COMMAND");
  expect(error.message).toContain("#general:#7 is a task conversation, not a message target.");
  expect(error.message).toContain("Nothing was sent.");
  expect(error.message).toContain(`coforge task reply "#general:#7" <<'COFORGE_MESSAGE'`);
});

test("message send still accepts ordinary targets and message threads", () => {
  for (const target of ["#general", "@ada", "#general:abcd1234"])
    expect(parseArgs(["message", "send", "--target", target])).toMatchObject({
      command: "send",
      target,
    });
});

test("message read refuses a task ref and carries the read window over", () => {
  const error = refusal(() =>
    parseArgs(["message", "read", "--target", "dm:@ada:#3", "--limit", "5", "--unread"]),
  );
  expect(error.code).toBe("TASK_TARGET_USE_TASK_COMMAND");
  expect(error.message).toContain("dm:@ada:#3 is a task conversation, not a message target.");
  expect(error.message).toContain(`coforge task read "dm:@ada:#3" --limit 5 --unread`);
  expect(
    refusal(() => parseArgs(["message", "read", "--target", "#general:#7", "--before", "abcd1234"]))
      .message,
  ).toContain(`coforge task read "#general:#7" --before abcd1234`);
  expect(
    refusal(() => parseArgs(["message", "read", "--target", "#general:#7"])).message,
  ).toContain(`coforge task read "#general:#7"`);
});

test("the refusal is not retryable and keeps the output mode", () => {
  const error = refusal(() => refuseTaskRef("send", "#general:#7", [], "json")) as {
    retryable?: boolean;
    outputMode?: string;
  };
  expect(error).toMatchObject({ retryable: false, outputMode: "json" });
});
