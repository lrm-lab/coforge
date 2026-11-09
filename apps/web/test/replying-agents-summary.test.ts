import { expect, test } from "bun:test";
import {
  agentsLineSummary,
  replyingAgentsAmong,
  replyingNames,
} from "#src/features/agents/replying-agents-summary";
import { m } from "#src/paraglide/messages";

// en-GB lists "A, B and C"; en-US would add the serial comma.
const names = (...list: string[]) => replyingNames(list, "en-GB");

test("one name is singular; two or three are plural and listed", () => {
  expect(names("Atlas")).toEqual({ kind: "list", text: "Atlas", plural: false });
  expect(names("Atlas", "Ben")).toEqual({ kind: "list", text: "Atlas and Ben", plural: true });
  expect(names("Atlas", "Ben", "Cam")).toEqual({
    kind: "list",
    text: "Atlas, Ben and Cam",
    plural: true,
  });
});

test("names read as Raft writes them: no serial comma in English, 和 and 、 in Chinese", () => {
  const list = (text: string) => ({ kind: "list" as const, text, plural: true });
  expect(replyingNames(["Olivia", "Ben", "Phoenix"], "en")).toEqual(
    list("Olivia, Ben and Phoenix"),
  );
  expect(replyingNames(["Olivia", "Ben", "Phoenix"], "zh-CN")).toEqual(
    list("Olivia、Ben 和 Phoenix"),
  );
  expect(replyingNames(["Olivia", "Ben"], "zh-CN")).toEqual(list("Olivia 和 Ben"));
  expect(replyingNames(["Olivia"], "zh-CN")).toEqual({
    kind: "list",
    text: "Olivia",
    plural: false,
  });
});

test("more than three name the first two and count both the rest and the whole", () => {
  expect(names("Atlas", "Ben", "Cam", "Dee")).toEqual({
    kind: "overflow",
    first: "Atlas",
    second: "Ben",
    rest: 2,
    total: 4,
  });
  expect(names("Atlas", "Ben", "Cam", "Dee", "Eve")).toMatchObject({ rest: 3, total: 5 });
});

test("the typing Agents are the live roster's, in the order they started, by display name", () => {
  const roster = [
    { id: "ben", name: "ben", displayName: "Ben", mascot: undefined },
    { id: "atlas", name: "atlas", displayName: " ", mascot: "blue" as const },
  ];
  const replying = replyingAgentsAmong(roster, ["atlas", "unknown", "ben"]);
  expect(replying.map(({ id, name }) => [id, name])).toEqual([
    ["atlas", "atlas"],
    ["ben", "Ben"],
  ]);
  expect(replying[0]!.mascot).toBe("blue");
  expect(replying[1]!.mascot).toBeTruthy();
});

test("the typing sentence counts the other agents, in both languages", () => {
  const overflow = { first: "Olivia", second: "Ben", rest: 2, total: 4 };
  expect(String(m.agent_replying_overflow(overflow, { locale: "en" }))).toBe(
    "Olivia, Ben and 2 other agents are typing",
  );
  expect(String(m.agent_replying_overflow(overflow, { locale: "zh-CN" }))).toBe(
    "Olivia、Ben 等 4 个 Agent 正在输入",
  );
  expect(String(m.agent_replying_many({ names: "Olivia 和 Ben" }, { locale: "zh-CN" }))).toBe(
    "Olivia 和 Ben 正在输入",
  );
  expect(String(m.agent_replying_one({ names: "Olivia" }, { locale: "zh-CN" }))).toBe(
    "Olivia 正在输入",
  );
});

test("typing alone ends in an ellipsis, in both languages", () => {
  const typing = "Olivia is typing";
  expect(String(m.agent_typing_alone({ typing }, { locale: "en" }))).toBe("Olivia is typing…");
  expect(String(m.agent_typing_alone({ typing: "Olivia 正在输入" }, { locale: "zh-CN" }))).toBe(
    "Olivia 正在输入…",
  );
});

test("typing beside others working reads as one clause each", () => {
  const typing = "Olivia is typing";
  expect(String(m.agent_typing_and_working({ typing, others: 2 }, { locale: "en" }))).toBe(
    "Olivia is typing, 2 others are working",
  );
  expect(String(m.agent_typing_and_working({ typing, others: 1 }, { locale: "en" }))).toBe(
    "Olivia is typing, 1 other is working",
  );
  expect(
    String(
      m.agent_typing_and_working({ typing: "Olivia 正在输入", others: 2 }, { locale: "zh-CN" }),
    ),
  ).toBe("Olivia 正在输入，另外 2 个在工作");
});

test("Agents working with nobody typing are counted as being here", () => {
  expect(String(m.agent_working_here({ count: 3 }, { locale: "en" }))).toBe(
    "3 agents working here",
  );
  expect(String(m.agent_working_here({ count: 1 }, { locale: "en" }))).toBe("1 agent working here");
  expect(String(m.agent_working_here({ count: 3 }, { locale: "zh-CN" }))).toBe(
    "3 个 Agent 正在这里工作",
  );
});

test("the line is typing alone, working alone, or typing beside the others working", () => {
  const agent = (id: string) => ({ id });
  expect(agentsLineSummary([agent("a")], [])).toEqual({
    sentence: "typing",
    others: [],
    faces: [agent("a")],
  });
  expect(agentsLineSummary([], [agent("a"), agent("b")])).toEqual({
    sentence: "working",
    others: [agent("a"), agent("b")],
    faces: [agent("a"), agent("b")],
  });
  expect(agentsLineSummary([agent("a")], [agent("b")])).toEqual({
    sentence: "typing-and-working",
    others: [agent("b")],
    faces: [agent("a"), agent("b")],
  });
});

test("an Agent both typing and working counts once, as typing", () => {
  const agent = (id: string) => ({ id });
  expect(agentsLineSummary([agent("a")], [agent("a")])).toEqual({
    sentence: "typing",
    others: [],
    faces: [agent("a")],
  });
  expect(agentsLineSummary([agent("a")], [agent("a"), agent("b")])!.others).toEqual([agent("b")]);
});

test("the faces stop at three, typing first, while the count covers everyone", () => {
  const agent = (id: string) => ({ id });
  const summary = agentsLineSummary(
    [agent("a")],
    [agent("b"), agent("c"), agent("d"), agent("e")],
  )!;
  expect(summary.faces).toEqual([agent("a"), agent("b"), agent("c")]);
  expect(summary.others).toHaveLength(4);
});

test("nobody typing or working leaves nothing to say", () => {
  expect(agentsLineSummary([], [])).toBeUndefined();
});
