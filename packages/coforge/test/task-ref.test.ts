import { expect, test } from "bun:test";
import { CliError } from "../src/cli-error";
import { resolveTaskRef } from "../src/task-ref";

function refusal(...args: Parameters<typeof resolveTaskRef>): CliError {
  try {
    resolveTaskRef(...args);
  } catch (error) {
    return error as CliError;
  }
  throw new Error("expected a refusal");
}

test("a channel ref names its board and number", () => {
  expect(resolveTaskRef("#general:#7", undefined, undefined)).toEqual({
    ref: "#general:#7",
    board: "#general",
    number: 7,
  });
});

test("a direct-message ref names its peer's board", () => {
  expect(resolveTaskRef("dm:@ada:#12", undefined, undefined)).toEqual({
    ref: "dm:@ada:#12",
    board: "dm:@ada",
    number: 12,
  });
});

test("--target and --number name the same task as the ref", () => {
  const expected = { ref: "#general:#7", board: "#general", number: 7 };
  expect(resolveTaskRef(undefined, "#general", "7")).toEqual(expected);
  expect(resolveTaskRef(undefined, "#general", "#7")).toEqual(expected);
  expect(resolveTaskRef("#general:#7", "#general", "7")).toEqual(expected);
  expect(resolveTaskRef(undefined, "dm:@ada", "3")).toEqual({
    ref: "dm:@ada:#3",
    board: "dm:@ada",
    number: 3,
  });
  expect(resolveTaskRef(undefined, "@ada", "3").ref).toBe("dm:@ada:#3");
});

test("a ref and a target that name different tasks are refused", () => {
  const error = refusal("#general:#7", "#general", "8");
  expect(error.code).toBe("INVALID_ARG");
  expect(error.message).toBe(
    "The ref #general:#7 and --target/--number name different tasks; give one of them.",
  );
});

test("naming no task is refused with the forms that work", () => {
  for (const args of [
    [undefined, undefined, undefined],
    [undefined, "#general", undefined],
    [undefined, undefined, "7"],
  ] as const) {
    const error = refusal(args[0], args[1], args[2]);
    expect(error.code).toBe("INVALID_ARG");
    expect(error.message).toBe(
      'Name the task by its ref, e.g. "#channel:#7" (quoted), or with --target "#channel" --number 7.',
    );
  }
});

test("a thread target, a bare number or a bare channel is not a task ref", () => {
  for (const raw of ["#general:abcd1234", "#general", "#7", "7", "#general:#0", "#general:#07"]) {
    const error = refusal(raw, undefined, undefined);
    expect(error.code).toBe("INVALID_TARGET");
    expect(error.message).toBe(
      `Not a task ref: ${raw}. A task is named "#channel:#7" (a task in a DM: "dm:@peer:#7"), or with --target "#channel" --number 7. Quote the ref: an unquoted # starts a shell comment.`,
    );
  }
});

test("a target that is not a board is refused", () => {
  const error = refusal(undefined, "general", "7");
  expect(error.code).toBe("INVALID_TARGET");
  expect(error.message).toBe(
    "--target must be a channel ('#channel') or a DM ('dm:@peer') holding the task board; got general",
  );
});

test("a number that is not a positive integer is refused", () => {
  for (const raw of ["0", "-1", "x", "1.5", ""]) {
    const error = refusal(undefined, "#general", raw);
    expect(error.code).toBe("INVALID_ARG");
    expect(error.message).toBe(`--number must be a positive integer; got ${raw}`);
  }
});
